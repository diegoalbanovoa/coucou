// Credential redactor: hides secrets in tool output before it reaches the
// model. Hand-written scanner (no regex dependency) over known token
// prefixes, PEM private-key blocks, passwords in URLs and `name = value`
// assignments whose name says "secret". No entropy detection on purpose, so
// git hashes, UUIDs and base64 stay intact.

pub struct Redaction {
    pub text: String,
    pub count: usize,
}

/// A span of the input to replace with `[REDACTED:<label>]`.
struct Hit {
    start: usize,
    end: usize,
    label: &'static str,
}

const ASSIGNMENT_NAMES: &[&str] = &[
    "password",
    "passwd",
    "pwd",
    "secret",
    "api_key",
    "apikey",
    "api-key",
    "auth_token",
    "access_token",
    "refresh_token",
    "token",
    "private_key",
    "client_secret",
    "secret_key",
];

pub fn redact(input: &str) -> Redaction {
    let b = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut last = 0;
    let mut count = 0;
    let mut i = 0;
    while i < b.len() {
        match find_at(input, i) {
            Some(hit) if hit.start >= last && hit.end > hit.start => {
                out.push_str(&input[last..hit.start]);
                out.push_str("[REDACTED:");
                out.push_str(hit.label);
                out.push(']');
                last = hit.end;
                i = hit.end;
                count += 1;
            }
            _ => i += 1,
        }
    }
    out.push_str(&input[last..]);
    Redaction { text: out, count }
}

fn find_at(s: &str, i: usize) -> Option<Hit> {
    if !s.is_char_boundary(i) {
        return None;
    }
    let b = s.as_bytes();
    let rest = &s[i..];
    if rest.starts_with("-----BEGIN ") {
        if let Some(h) = private_key(s, i) {
            return Some(h);
        }
    }
    if rest.starts_with("://") {
        if let Some(h) = url_password(s, i + 3) {
            return Some(h);
        }
    }
    if b[i] == b'=' || b[i] == b':' {
        if let Some(h) = assignment(s, i) {
            return Some(h);
        }
    }
    if i > 0 && is_token_byte(b[i - 1]) {
        return None; // not at a word boundary
    }
    token(s, i)
}

fn is_token_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'-'
}

/// Length of the run starting at `from` whose bytes satisfy `ok`.
fn run(b: &[u8], from: usize, ok: impl Fn(u8) -> bool) -> usize {
    b[from..].iter().take_while(|&&c| ok(c)).count()
}

fn private_key(s: &str, i: usize) -> Option<Hit> {
    let header_from = i + "-----BEGIN ".len();
    let header_end = header_from + s[header_from..].find("-----")?;
    if !s[header_from..header_end].ends_with("PRIVATE KEY") {
        return None;
    }
    let body_from = header_end + 5;
    let end = match s[body_from..].find("-----END ") {
        Some(off) => {
            let end_from = body_from + off + "-----END ".len();
            // Through the closing dashes, then to the end of that line.
            let after = match s[end_from..].find("-----") {
                Some(c) => end_from + c + 5,
                None => end_from,
            };
            after + s[after..].find(['\n', '\r']).unwrap_or(s.len() - after)
        }
        None => s.len(),
    };
    Some(Hit { start: i, end, label: "private_key" })
}

fn url_password(s: &str, from: usize) -> Option<Hit> {
    let b = s.as_bytes();
    let stop = |c: u8| c.is_ascii_whitespace() || matches!(c, b'/' | b'"' | b'\'' | b'<' | b'>');
    let n = run(b, from, |c| !stop(c));
    let authority = &s[from..from + n];
    let at = authority.find('@')?;
    let colon = authority[..at].find(':')?;
    let pass_start = from + colon + 1;
    let pass_end = from + at;
    if pass_end == pass_start || s[pass_start..pass_end].starts_with("[REDACTED:") {
        return None;
    }
    Some(Hit { start: pass_start, end: pass_end, label: "url_password" })
}

fn assignment(s: &str, i: usize) -> Option<Hit> {
    let b = s.as_bytes();
    if i + 1 < b.len() && matches!(b[i + 1], b'=' | b'>' | b':') {
        return None;
    }
    if i > 0 && matches!(b[i - 1], b'=' | b'!' | b'<' | b'>' | b':') {
        return None;
    }
    // Backwards: spaces, an optional closing quote, then the name.
    let mut k = i;
    while k > 0 && matches!(b[k - 1], b' ' | b'\t') {
        k -= 1;
    }
    if k > 0 && matches!(b[k - 1], b'"' | b'\'') {
        k -= 1;
    }
    let name_end = k;
    while k > 0 && (b[k - 1].is_ascii_alphanumeric() || matches!(b[k - 1], b'_' | b'.' | b'-')) {
        k -= 1;
    }
    let name = s[k..name_end].to_ascii_lowercase();
    if !ASSIGNMENT_NAMES.iter().any(|n| name.ends_with(n)) {
        return None;
    }
    // Forwards: the value.
    let mut v = i + 1;
    while v < b.len() && matches!(b[v], b' ' | b'\t') {
        v += 1;
    }
    if v >= b.len() {
        return None;
    }
    let skipped = |value: &str| {
        value.starts_with(['$', '<', '{', '%']) || value.starts_with("[REDACTED:")
    };
    if matches!(b[v], b'"' | b'\'') {
        let quote = b[v];
        let from = v + 1;
        let len = b[from..].iter().position(|&c| c == quote || c == b'\n')?;
        if b[from + len] != quote {
            return None;
        }
        let value = &s[from..from + len];
        if value.chars().count() < 4 || skipped(value) {
            return None;
        }
        return Some(Hit { start: from, end: from + len, label: "assignment" });
    }
    let end_at = |c: u8| c.is_ascii_whitespace() || matches!(c, b',' | b';' | b'}' | b']' | b')');
    let n = run(b, v, |c| !end_at(c));
    let value = &s[v..v + n];
    if skipped(value) || value.chars().count() < 8 {
        return None;
    }
    let has_mark = value
        .bytes()
        .any(|c| c.is_ascii_digit() || matches!(c, b'-' | b'_' | b'/' | b'+' | b'=' | b'.' | b'!' | b'@' | b'#' | b'$' | b'%' | b'^' | b'&' | b'*'));
    if !has_mark {
        return None;
    }
    Some(Hit { start: v, end: v + n, label: "assignment" })
}

fn token(s: &str, i: usize) -> Option<Hit> {
    let b = s.as_bytes();
    let rest = &s[i..];
    let class = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'-';
    let alnum = |c: u8| c.is_ascii_alphanumeric();
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let prefixed = |prefix: &str, min: usize, ok: &dyn Fn(u8) -> bool, label: &'static str| -> Option<Hit> {
        if !rest.starts_with(prefix) {
            return None;
        }
        let n = run(b, i + prefix.len(), ok);
        (n >= min).then_some(Hit { start: i, end: i + prefix.len() + n, label })
    };

    if let Some(h) = prefixed("sk-ant-", 20, &class, "anthropic_key") {
        return Some(h);
    }
    if let Some(h) = prefixed("sk-", 20, &class, "openai_key") {
        return Some(h);
    }
    for p in ["sk_live_", "sk_test_", "rk_live_", "rk_test_"] {
        if let Some(h) = prefixed(p, 20, &alnum, "stripe_key") {
            return Some(h);
        }
    }
    for p in ["AKIA", "ASIA"] {
        if rest.starts_with(p) {
            let n = run(b, i + 4, |c| c.is_ascii_digit() || c.is_ascii_uppercase());
            let after = b.get(i + 4 + 16);
            if n >= 16 && !after.is_some_and(|c| c.is_ascii_alphanumeric()) {
                return Some(Hit { start: i, end: i + 4 + 16, label: "aws_access_key" });
            }
        }
    }
    for p in ["ghp_", "gho_", "ghs_", "ghr_", "ghu_"] {
        if let Some(h) = prefixed(p, 36, &word, "github_token") {
            return Some(h);
        }
    }
    if let Some(h) = prefixed("github_pat_", 22, &word, "github_token") {
        return Some(h);
    }
    for p in ["xoxb-", "xoxp-", "xoxa-", "xoxr-", "xoxs-", "xoxo-"] {
        if let Some(h) = prefixed(p, 10, &|c: u8| c.is_ascii_alphanumeric() || c == b'-', "slack_token") {
            return Some(h);
        }
    }
    if let Some(h) = prefixed("AIza", 35, &class, "google_api_key") {
        return Some(h);
    }
    if rest.starts_with("eyJ") {
        let mut p = i + 3;
        let first = run(b, p, class);
        if first >= 10 {
            p += first;
            let mut ok = true;
            for _ in 0..2 {
                if b.get(p) != Some(&b'.') {
                    ok = false;
                    break;
                }
                let n = run(b, p + 1, class);
                if n < 10 {
                    ok = false;
                    break;
                }
                p += 1 + n;
            }
            if ok {
                return Some(Hit { start: i, end: p, label: "jwt" });
            }
        }
    }
    if rest.len() >= 6 && rest.as_bytes()[..6].eq_ignore_ascii_case(b"bearer") {
        let gap = run(b, i + 6, |c| matches!(c, b' ' | b'\t'));
        if gap > 0 {
            let from = i + 6 + gap;
            let n = run(b, from, |c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.' | b'~' | b'+' | b'/' | b'='));
            if n >= 20 {
                return Some(Hit { start: from, end: from + n, label: "bearer_token" });
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(n: usize) -> String {
        "a1B2".repeat(n)
    }

    fn one(input: &str, expected: &str) {
        let r = redact(input);
        assert_eq!(r.text, expected, "input: {input}");
        assert!(r.count >= 1, "input: {input}");
    }

    #[test]
    fn a_pem_private_key_block_is_hidden_whole() {
        let text = "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\nafter";
        one(text, "before\n[REDACTED:private_key]\nafter");
    }

    #[test]
    fn an_openssh_key_without_an_end_is_hidden_to_the_end() {
        one("x\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef", "x\n[REDACTED:private_key]");
    }

    #[test]
    fn a_public_pem_block_is_left_alone() {
        let text = "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----";
        assert_eq!(redact(text).count, 0);
    }

    #[test]
    fn a_password_in_a_url_is_hidden_but_the_rest_stays() {
        one(
            "postgres://admin:hunter2@db:5432/app",
            "postgres://admin:[REDACTED:url_password]@db:5432/app",
        );
    }

    #[test]
    fn assignments_by_name_are_hidden() {
        one("DB_PASSWORD=s3cr3tValue", "DB_PASSWORD=[REDACTED:assignment]");
        one("\"api_key\": \"abcd1234\"", "\"api_key\": \"[REDACTED:assignment]\"");
        one("password: 'hunter2!'", "password: '[REDACTED:assignment]'");
        one("client_secret: Abc123xyz789", "client_secret: [REDACTED:assignment]");
    }

    #[test]
    fn an_assignment_wins_over_the_token_inside_it() {
        let key = format!("sk-{}", a(6));
        one(&format!("export OPENAI_API_KEY=\"{key}\""), "export OPENAI_API_KEY=\"[REDACTED:assignment]\"");
    }

    #[test]
    fn known_token_prefixes_get_their_label() {
        let cases: Vec<(String, &str)> = vec![
            (format!("sk-ant-{}", a(6)), "anthropic_key"),
            (format!("sk-proj-{}", a(6)), "openai_key"),
            (format!("sk_live_{}", a(6)), "stripe_key"),
            ("AKIAIOSFODNN7EXAMPLE".to_string(), "aws_access_key"),
            (format!("ghp_{}", "a1B2c3D4".repeat(5)), "github_token"),
            (format!("github_pat_{}", "a1B2c3D4".repeat(3)), "github_token"),
            ("xoxb-1234567890-abcdefghij".to_string(), "slack_token"),
            (format!("AIza{}", a(10)), "google_api_key"),
            ("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop".to_string(), "jwt"),
        ];
        for (token, label) in cases {
            one(&format!("key {token} end"), &format!("key [REDACTED:{label}] end"));
        }
    }

    #[test]
    fn a_bearer_token_keeps_the_word() {
        one(
            "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
            "Authorization: Bearer [REDACTED:bearer_token]",
        );
    }

    #[test]
    fn several_secrets_are_counted() {
        let r = redact(&format!("a sk-{} b AKIAIOSFODNN7EXAMPLE c password=abc12345", a(6)));
        assert_eq!(r.count, 3);
    }

    #[test]
    fn non_ascii_text_around_a_secret_is_untouched() {
        let r = redact(&format!("contraseña ñ sk-{} é", a(6)));
        assert_eq!(r.text, "contraseña ñ [REDACTED:openai_key] é");
        assert_eq!(r.count, 1);
    }

    #[test]
    fn redacting_twice_finds_nothing_more() {
        let all = format!(
            "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n\
             postgres://admin:hunter2@db:5432/app\nDB_PASSWORD=s3cr3tValue\n\"api_key\": \"abcd1234\"\n\
             export OPENAI_API_KEY=\"sk-{k}\"\npassword: 'hunter2!'\nclient_secret: Abc123xyz789\n\
             sk-ant-{k}\nsk-proj-{k}\nsk_live_{k}\nAKIAIOSFODNN7EXAMPLE\nxoxb-1234567890-abcdefghij\n\
             AIza{k}\neyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop\n\
             Authorization: Bearer abcdefghijklmnopqrstuvwxyz\nghp_{g}",
            k = a(6),
            g = "a1B2c3D4".repeat(5)
        );
        let first = redact(&all);
        assert!(first.count >= 15);
        assert_eq!(redact(&first.text).count, 0);
        assert_eq!(redact(&first.text).text, first.text);
    }

    #[test]
    fn look_alikes_are_left_untouched() {
        let g = format!("pk_live_{}", "a1B2c3D4".repeat(3));
        let cases = [
            "risk-assessment-documentation-final-v2",
            "task-12345678901234567890abc",
            "max_tokens: 1024",
            "password_reset_url = \"https://example.com/reset\"",
            "token: string",
            "token: undefined",
            "if password == \"abc\"",
            "secret::get(&key)",
            "postgres://localhost:5432/app",
            "https://example.com/a:b@c",
            "AKIA",
            "da39a3ee5e6b4b0d3255bfef95601890afd80709",
            "123e4567-e89b-12d3-a456-426614174000",
            "Password: see the wiki",
            g.as_str(),
            "The password is stored in the keychain.",
            "API_KEY=${OPENAI_API_KEY}",
            "api_key: <your-key>",
        ];
        for c in cases {
            let r = redact(c);
            assert_eq!(r.text, c);
            assert_eq!(r.count, 0, "{c}");
        }
    }
}
