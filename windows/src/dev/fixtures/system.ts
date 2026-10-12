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
  protected: boolean;
  /** A string, matching the real `ProcInfo.startTime` — see its own note on
   *  why a Windows FILETIME cannot cross the JS bridge as a JSON number. */
  startTime: string;
}

export interface MockStats {
  drives: MockDrive[];
  memoryUsed: number;
  memoryTotal: number;
  cpuPercent: number;
  cores: number;
  diskCleanupAvailable: boolean;
}

export type MockScenario = "ok" | "strained" | "sick";

const TOTAL_MEMORY = 16 * GB;

/** CPU percent per scenario — folded into `MOCK_SCENARIOS` below and also
 *  exported on its own for the health monitor Fase 7 adds. */
export const MOCK_CPU: Record<MockScenario, number> = {
  ok: 18,
  strained: 32,
  sick: 91,
};

export const MOCK_SCENARIOS: Record<MockScenario, MockStats> = {
  ok: {
    drives: [
      { name: "C:", free: 120 * GB, total: 476 * GB },
      { name: "D:", free: 800 * GB, total: 931 * GB },
    ],
    memoryUsed: Math.round(TOTAL_MEMORY * 0.45),
    memoryTotal: TOTAL_MEMORY,
    cpuPercent: MOCK_CPU.ok,
    cores: 8,
    diskCleanupAvailable: true,
  },
  strained: {
    drives: [
      { name: "C:", free: 51 * GB, total: 237 * GB },
      { name: "D:", free: 800 * GB, total: 931 * GB },
    ],
    memoryUsed: Math.round(TOTAL_MEMORY * 0.76),
    memoryTotal: TOTAL_MEMORY,
    cpuPercent: MOCK_CPU.strained,
    cores: 8,
    diskCleanupAvailable: true,
  },
  sick: {
    drives: [
      { name: "C:", free: 9 * GB, total: 237 * GB },
      { name: "D:", free: 800 * GB, total: 931 * GB },
    ],
    memoryUsed: Math.round(TOTAL_MEMORY * 0.88),
    memoryTotal: TOTAL_MEMORY,
    cpuPercent: MOCK_CPU.sick,
    cores: 8,
    diskCleanupAvailable: true,
  },
};

const MB = 1024 ** 2;

/** 15 processes with repeats, as `system_processes` would hand them back —
 *  already heaviest-first, the way the real command sorts them. One
 *  (`MsMpEng.exe`) is protected, to prove the lock glyph has something to
 *  show in a screenshot rather than only in a unit test. */
export const MOCK_PROCESSES: MockProcInfo[] = [
  { pid: 10412, name: "claude.exe", memory: Math.round(1.36 * GB / 3), protected: false, startTime: "1001" },
  { pid: 20072, name: "claude.exe", memory: Math.round(1.36 * GB / 3), protected: false, startTime: "1002" },
  { pid: 13288, name: "claude.exe", memory: Math.round(1.36 * GB / 3), protected: false, startTime: "1003" },
  { pid: 8841, name: "msedgewebview2.exe", memory: 372 * MB, protected: false, startTime: "1004" },
  { pid: 9102, name: "msedgewebview2.exe", memory: 298 * MB, protected: false, startTime: "1005" },
  { pid: 4410, name: "msedge.exe", memory: 309 * MB, protected: false, startTime: "1006" },
  { pid: 4512, name: "msedge.exe", memory: 211 * MB, protected: false, startTime: "1007" },
  { pid: 7781, name: "chrome.exe", memory: 239 * MB, protected: false, startTime: "1008" },
  { pid: 7790, name: "chrome.exe", memory: 188 * MB, protected: false, startTime: "1009" },
  { pid: 5521, name: "Obsidian.exe", memory: 420 * MB, protected: false, startTime: "1010" },
  { pid: 6630, name: "rustc.exe", memory: 859 * MB, protected: false, startTime: "1011" },
  { pid: 6631, name: "cargo.exe", memory: 100 * MB, protected: false, startTime: "1012" },
  { pid: 2211, name: "node.exe", memory: 142 * MB, protected: false, startTime: "1013" },
  { pid: 3301, name: "Code.exe", memory: 512 * MB, protected: false, startTime: "1014" },
  { pid: 1428, name: "MsMpEng.exe", memory: 268 * MB, protected: true, startTime: "1015" },
].sort((a, b) => b.memory - a.memory);
