// Fixture system data for mock mode (see plan-v2.md § 0.2).
//
// Three scenarios the `?scenario=` URL param selects — `ok`, `strained`,
// `sick` — matching the health levels Fase 7 introduces, plus a process list
// with the repeats real life has (`claude.exe` ×3: this session, a second
// window, and one gone stale) so Fase 6's "group by executable" has something
// to prove itself against.

const GB = 1024 ** 3;

export interface MockDrive {
  name: string;
  free: number;
  total: number;
}

export interface MockProcInfo {
  pid: number;
  name: string;
  memory: number;
}

export interface MockStats {
  drives: MockDrive[];
  memoryUsed: number;
  memoryTotal: number;
  diskCleanupAvailable: boolean;
}

export type MockScenario = "ok" | "strained" | "sick";

const TOTAL_MEMORY = 16 * GB;

export const MOCK_SCENARIOS: Record<MockScenario, MockStats> = {
  ok: {
    drives: [
      { name: "C:", free: 120 * GB, total: 476 * GB },
      { name: "D:", free: 800 * GB, total: 931 * GB },
    ],
    memoryUsed: Math.round(TOTAL_MEMORY * 0.45),
    memoryTotal: TOTAL_MEMORY,
    diskCleanupAvailable: true,
  },
  strained: {
    drives: [
      { name: "C:", free: 51 * GB, total: 237 * GB },
      { name: "D:", free: 800 * GB, total: 931 * GB },
    ],
    memoryUsed: Math.round(TOTAL_MEMORY * 0.76),
    memoryTotal: TOTAL_MEMORY,
    diskCleanupAvailable: true,
  },
  sick: {
    drives: [
      { name: "C:", free: 9 * GB, total: 237 * GB },
      { name: "D:", free: 800 * GB, total: 931 * GB },
    ],
    memoryUsed: Math.round(TOTAL_MEMORY * 0.88),
    memoryTotal: TOTAL_MEMORY,
    diskCleanupAvailable: true,
  },
};

/** CPU percent per scenario — the health monitor's other half (Fase 7). */
export const MOCK_CPU: Record<MockScenario, number> = {
  ok: 18,
  strained: 32,
  sick: 91,
};

const MB = 1024 ** 2;

/** 14 processes with repeats, as `system_processes` would hand them back —
 *  already heaviest-first, the way the real command sorts them. */
export const MOCK_PROCESSES: MockProcInfo[] = [
  { pid: 10412, name: "claude.exe", memory: Math.round(1.36 * GB / 3) },
  { pid: 20072, name: "claude.exe", memory: Math.round(1.36 * GB / 3) },
  { pid: 13288, name: "claude.exe", memory: Math.round(1.36 * GB / 3) },
  { pid: 8841, name: "msedgewebview2.exe", memory: 372 * MB },
  { pid: 9102, name: "msedgewebview2.exe", memory: 298 * MB },
  { pid: 4410, name: "msedge.exe", memory: 309 * MB },
  { pid: 4512, name: "msedge.exe", memory: 211 * MB },
  { pid: 7781, name: "chrome.exe", memory: 239 * MB },
  { pid: 7790, name: "chrome.exe", memory: 188 * MB },
  { pid: 5521, name: "Obsidian.exe", memory: 420 * MB },
  { pid: 6630, name: "rustc.exe", memory: 859 * MB },
  { pid: 6631, name: "cargo.exe", memory: 100 * MB },
  { pid: 2211, name: "node.exe", memory: 142 * MB },
  { pid: 3301, name: "Code.exe", memory: 512 * MB },
].sort((a, b) => b.memory - a.memory);
