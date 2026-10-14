// Fixture routines and results for mock mode (plan v4, Fase 7).

import type { Routine, RoutineResult } from "../../core/bridge";

export const MOCK_ROUTINES: Routine[] = [
  {
    id: "r-morning",
    label: "Morning digest",
    prompt: "Summarize what I should look at this morning.",
    profileId: "mock-profile",
    time: "08:30",
    days: [1, 2, 3, 4, 5],
    tools: false,
    skill: null,
    enabled: true,
  },
];

const now = Date.now();

export const MOCK_ROUTINE_RESULTS: RoutineResult[] = [
  {
    routineId: "r-morning",
    label: "Morning digest",
    at: now - 5 * 60_000,
    ok: true,
    outcome: "done",
    text: "## Good morning\n\n- Two pull requests are waiting for review.\n- The Vercel deploy from last night **passed**.\n- You have a call at 11:00.",
  },
  {
    routineId: "r-morning",
    label: "Morning digest",
    at: now - 26 * 3_600_000,
    ok: false,
    outcome: "error",
    text: "invalid-key:the API key was rejected",
  },
];
