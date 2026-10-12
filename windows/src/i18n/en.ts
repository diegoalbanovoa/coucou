// The source of truth for every visible string in the island and the
// settings window. es.ts must carry exactly this shape — see index.ts's
// `Messages` type, which fails to compile if a key is missing or extra.
//
// Proper nouns are never here: n8n, Vercel, GitHub, Stripe, Resend, Cal.com,
// Notion, Claude Code, Gemini, Codex, Copilot, Cursor, Qwen, OpenCode,
// PowerShell, Windows Terminal, VS Code, Coucou and Mochi stay as written at
// the call site. A CLI's own replies are never translated either.

export const en = {
  tabs: {
    // These are today's real tooltips, not the plan's eventual "Home"/"Chat"
    // — Fase 2 translates what exists; renaming the tabs is Fase 3's job.
    home: "Overview",
    chat: "Ask",
    system: "System",
    settings: "Settings",
    mute: "Mute",
    openTarget: "Open",
  },

  home: {
    pane: {
      consoles: "Consoles",
      services: "Services",
    },
  },

  consoles: {
    count: { one: "{n} console", other: "{n} consoles" },
    found: "No agent console found",
    searchHint: "Coucou looks on PATH and where npm, nvm, Volta, Bun, pnpm and the vendors' own installers put things.",
    runningNow: "running now",
    cap: {
      streams: "streams",
      oneShot: "one shot",
      resume: "resumes",
      approvableHere: "approvable here",
      asksInTerminal: "asks in its terminal",
      unverified: "unverified",
    },
    use: "Use this console",
    inUse: "In use",
    rescan: "Search again",
    sessions: { one: "{n} session", other: "{n} sessions" },
    notFound: "Not found",
    foundNew: { one: "Found {n} new console", other: "Found {n} new consoles" },
    noneNew: "No new consoles found",
  },

  chat: {
    attachProject: "Attach project…",
    noAgentFound: "No agent CLI found",
    pickAgent: "Pick an agent",
    placeholderNoCli: "No agent CLI found — install one to chat…",
    placeholderNoProject: "Attach a project folder first…",
    placeholderContinue: "Continue…",
    placeholderAsk: "Ask, or / for a command…",
    send: "Send",
    switchConsole: "Switch between the installed agent consoles",
    copyReply: "Copy the reply",
    copied: "Copied",
    copyFailed: "Could not copy",
    showWhole: "Show the whole reply",
    foldBack: "Fold it back up",
    turnStopped: "The turn stopped",
    retry: "Retry",
    noReply: "No reply came back.",
    jumpToLatest: "Jump to the latest",
    emptyTitle: "Ask away.",
    attachImage: "Attach an image",
    steps: { one: "{n} step", other: "{n} steps" },
    hideSteps: "hide",
    findPlaceholder: "Find in the conversation…",
    findTitle: "Find in the conversation (Ctrl+F)",
    findPrev: "Previous (Shift+Enter)",
    findNext: "Next (Enter)",
    findClose: "Close (Escape)",
    // What search.ts's counter() shows when there is nothing to count — "none"
    // on purpose, not "0/0": see that file's own note on why.
    searchNone: "none",
    detachProject: "{path}",
    chooseProjectFolder: "Choose the folder the agent works in",
    changeProject: "Change…",
    removeProject: "Remove",
    shrink: "Make the chat smaller",
    grow: "Use the whole height",
    stopTurn: "Stop this turn",
    more: "More",
    newChat: "New chat",
    newChatConfirm: "Start a new chat? This clears the conversation.",
    copyConversation: "Copy the conversation",
    you: "You",
    openProjectInVSCode: "Open the project in Visual Studio Code",
  },

  files: {
    dropTitle: "Drop your files here",
    kind: { pdf: "PDF", images: "Images", code: "Code", docs: "Docs" },
    remove: "Remove {name}",
    blocked: "{name} can't be attached — Coucou doesn't accept that kind of file.",
    tooMany: { one: "Up to {max} file on one message.", other: "Up to {max} files on one message." },
    missing: "No longer there",
    /** Header line above the bulleted path list a turn's prompt carries when
     *  files are attached (plan-v2.md § 5.6) — read by the agent, never shown
     *  in the island, but still routed through t() like everything else. */
    promptHeader: "Attached files:",
    tooLarge: "{name} is larger than {max}.",
  },

  system: {
    memory: "Memory",
    free: "{size} free",
    usedOf: "{used} of {total}",
    openCleanup: "Open Windows Disk Cleanup",
    cleanupFailed: "Could not start it",
    topMemory: "using the most memory",
    scanAgain: "Look again",
    scanFirst: "Look for what can go",
    neverMind: "Never mind",
    endProcess: "End it",
    endProcessTitle: "End {name}",
    deleteN: { one: "Delete {n} file · {size}", other: "Delete {n} files · {size}" },
    nothingToClean: "nothing to clean",
    fileCount: { one: "{n} file", other: "{n} files" },
    notLookedAt: "not looked at yet",
    removedFreed: { one: "{n} removed · {size} freed", other: "{n} removed · {size} freed" },
    inUseLeftAlone: { one: "{n} in use, left alone", other: "{n} in use, left alone" },

    // Fase 6 (plan-v2.md § 6) — the headline, the three gauges, the
    // processes/storage segmented pane, and the "Free up space…" sheet.
    tabProcesses: "Processes",
    tabStorage: "Storage",
    // openspec/changes/agent-activity-panel — subagent activity pane.
    tabAgents: "Agents",
    agentsEmpty: "No subagent activity yet this session",
    statusOk: "Your machine is doing fine",
    statusStrained: "Your machine is working hard",
    statusSick: "Your machine needs help",
    detail: "Memory at {mem} · CPU {cpu}",
    cpuLabel: "CPU",
    memoryLabel: "Memory",
    cores: { one: "{n} core", other: "{n} cores" },
    /** Composed with the gauge's own label, value and detail — see
     *  ui/gauge.ts's file note on why the wording of "high"/"critical"
     *  belongs to the caller and not the component. */
    gaugeNormal: "{label} {value} percent, {detail}",
    gaugeHigh: "{label} {value} percent, high, {detail}",
    gaugeCritical: "{label} {value} percent, critical, {detail}",
    seeMore: "See more",
    moreActions: "More actions",
    viewProcesses: { one: "View process ({n})", other: "View processes ({n})" },
    endConfirmGroup: { one: "End {name}?", other: "End {name} ({n} processes)?" },
    agentWarning: "This is an agent CLI — ending it may interrupt work in progress.",
    endFailed: { one: "Could not end 1 process", other: "Could not end {n} processes" },
    protected: "Protected",
    freeUpSpace: "Free up space…",
    driveFree: "{free} free of {total}",
    analyzing: "Analyzing…",
    needsAdmin: "Needs administrator rights",
    windowsTemp: "Windows' own Temp folder",
    windowsUpdate: "Windows Update's leftovers",
    cleaning: "Cleaning…",
    /** The cleanup sheet's category names — system.rs's own `Target.label`
     *  is an internal, English, log-line string and never shown; these are
     *  what the sheet actually displays, keyed by the same ids. */
    target: {
      temp: "Temporary files",
      recycle: "Recycle Bin",
      npmCache: "npm cache",
      pipCache: "pip cache",
      coucouInbox: "Coucou's inbox",
      coucouLog: "Coucou's log",
    },
  },

  integrations: {
    hooksNotInstalled: "Hooks not installed",
    keyNotConfigured: "Key not configured",
    connectedLoading: "Connected · loading…",
    openVSCode: "Open Visual Studio Code",
    openN8n: "Open n8n",
    openService: "Open {name}",
    refresh: "Refresh",
    settingsLink: "Settings…",
    details: "Details",
    noCallsScheduled: "No calls scheduled",
    justNow: "just now",
    timeAgo: "{time} ago",
    kind: {
      integration: "Integration",
      deployments: "Deployments",
      emails: "Emails",
      overview: "Overview",
      payments: "Payments",
      recent: "Recent",
      schedule: "Schedule",
      workflow: "Workflow",
    },
    status: {
      ready: "Ready",
      canceled: "Canceled",
      error: "Error",
    },
    deploymentFallback: "Deployment",
    totalStars: "Total stars",
    repositories: "Repositories",
  },

  overview: {
    needsPermission: "needs permission",
    askingQuestion: "Claude Code is asking a question",
    answerInTerminal: "Answer in your terminal — Coucou can't reply for you yet.",
    claudeNeedsAnswer: "Claude needs an answer.",
    workflowStopped: "Workflow stopped.",
    sessionStoppedOnError: "Session stopped on an error.",
    noDetail: "No detail available.",
    claudeCodeFinished: "Claude Code finished",
    sessionFinished: "Session finished",
    tooManyHits: "Too many hits at once.",
    backToWork: "Give me a sec — back to work in three seconds.",
    deny: "Deny",
    allow: "Allow",
    retry: "Retry",
    openInN8n: "Open in n8n",
    openTerminal: "Open terminal",
    ok: "OK",
    sendingByEmail: "Sending by email isn't in this version.",
    searching: "Claude is searching…",
    result: "Result",
  },

  settings: {
    claudeCode: {
      title: "Claude Code",
      settingsJson: "settings.json",
      relay: "Relay",
      relayMissing:
        "coucou-hook.exe is not in place yet. Restart Coucou; if it still fails, build it with `cargo build -p coucou-hook`.",
      hookedIn:
        "Coucou is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there.",
      notHookedIn:
        "Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing.",
      relayNotReady: "The relay isn't installed yet.",
      install: "Install hooks…",
      reinstall: "Reinstall hooks…",
      uninstallHooks: "Uninstall hooks…",
      previewInstall: "This is exactly what will change in your settings.json. Your own hooks are left untouched.",
      previewUninstall: "This removes Coucou's entries only. Your own hooks are left untouched.",
      backupLabel: "Backup → {backup}",
      confirmInstall: "Back up and write",
      confirmUninstall: "Back up and remove",
      doneMessage: "Done. Previous settings saved as {backup}. Open a new Claude Code session to pick the hooks up.",
      writeError: "Could not write: {error}",
      back: "Back",
      cancel: "Cancel",
    },
    agents: {
      title: "Agents",
      config: "config",
      rescan: "Look again",
      looking: "Looking…",
      noneFound: "None found. Coucou looks on PATH and in the folders npm, nvm, Volta, Bun, pnpm and the vendors' own installers use.",
      summary: {
        one: "{n} found. The chat runs whichever one you pick in the island; only Claude Code streams its reply and can be resumed, because it is the one whose hooks Coucou installs.",
        other: "{n} found. The chat runs whichever one you pick in the island; only Claude Code streams its reply and can be resumed, because it is the one whose hooks Coucou installs.",
      },
      versionUnknown: "version unknown",
    },
    integrations: {
      advanced: "Advanced",
      integrationKeys: "Integration keys",
      save: "Save",
      pickUpTo: "Pick up to {max} pills to show next to Mochi — {used}/{max} in use. Keys are stored in the Windows Credential Manager, never on disk.",
      stored: "••••••••  (stored)",
      fields: {
        secretKey: "Secret key",
        token: "Token",
        instanceUrl: "Instance URL",
        apiKey: "API key",
        integrationToken: "Integration token",
      },
    },
    chatFolder: {
      title: "The chat's folder",
      default: "Default",
      choose: "Choose the folder…",
      chooseAnother: "Choose another…",
      clear: "Clear",
      noneSet: "Not set, so the chat needs a project attached from the island before it can run a turn.",
      usedWhenNoProject: "Used when no project is attached. Attaching one from the island still wins.",
      folderGone: "This folder is not there any more. The setting is kept in case the drive comes back — clear it or choose another.",
    },
    vault: {
      title: "Knowledge base",
      vault: "Vault",
      choose: "Choose the folder…",
      chooseAnother: "Choose another…",
      useObsidians: "Use Obsidian's",
      fromObsidian: "Read from Obsidian's own list of vaults. The agent can read and write inside it.",
      fromObsidianMany: "Read from Obsidian's own list of vaults ({n} of them). The agent can read and write inside it.",
      chosenOverride: "Chosen here, which overrides Obsidian's own list.",
      noneFound: "None found. Obsidian is not installed, or its vault list is empty — point Coucou at the folder and the agent can use it as a knowledge base.",
    },
    general: {
      title: "General",
      sound: "Sound",
      autoClose: "Auto-close",
      autoCloseHint: "seconds after you leave the island",
      islandLivesOn: "Island lives on",
      mainDisplay: "Main display",
      displayUnderCursor: "Display under the cursor",
      launchAtStartup: "Launch at startup",
      language: "Language",
      languageSystem: "System",
    },
    health: {
      title: "Team health",
      enabled: "Mochi reacts to the machine's load",
      threshold: "Get strained above",
      includeDisk: "Include disk usage",
      diskThreshold: "Disk threshold",
      notify: "Notify me when it gets worse",
    },
    footer: "No telemetry. Network requests only go to the services you configure yourself.",
  },

  common: {
    cancel: "Cancel",
    done: "Done",
    back: "Back",
  },

  tray: {
    open: "Open Coucou",
    settings: "Settings…",
    pause: "Pause",
    quit: "Quit",
  },

  // Fase 7 (plan-v2.md § 7) — Mochi's mood, not a machine state. `strained`
  // has no "ok" entry: ok is silent, nothing to say.
  health: {
    mochiSays: {
      strained: "Feeling a little dizzy — {cause}",
      sick: "Not feeling well — {cause}",
    },
    cause: {
      cpu: "CPU at {value}",
      memory: "memory at {value}",
      disk: "disk at {value}",
    },
  },
} as const;

export type En = typeof en;
