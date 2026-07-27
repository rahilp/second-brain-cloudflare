import type { Messages } from "./types";

export const en: Messages = {
  common: {
    back: "Back",
    continue: "Continue",
    copy: "Copy",
    copied: "Copied ✓",
    copyBoth: "Copy both",
    copyLink: "Copy link",
    copyAddress: "Copy address",
    copyCommand: "Copy command",
    connect: "Connect",
    connecting: "Connecting…",
    connected: "Connected ✓",
    openSettings: "Open settings",
    emailDetails: "Email these to myself",
    notNow: "Not now",
    tryAgain: "Try again",
    checking: "Checking…",
    ready: "Ready",
    notFound: "Not found",
    demoMode: "Demo mode",
  },
  settings: {
    title: "Settings",
    language: "Language",
    languageDesc: "Choose how the Second Brain app is displayed on this computer.",
    english: "English",
    italian: "Italiano",
  },
  welcome: {
    title: "Let's set up your Second Brain",
    lede:
      "One private memory that every AI tool you use can share. " +
      "It takes about two minutes, lives in your own private space, " +
      "and nothing technical is required.",
    getStarted: "Get started",
    alreadyHave: "Already have a Second Brain?",
    footnote: "Free to run · Your data stays yours",
  },
  connectExisting: {
    title: "Connect your Second Brain",
    lede:
      "Setting up a new computer? Enter the address and password of the " +
      "Second Brain you already have — nothing will be changed or reset.",
    addressPlaceholder: "Your Second Brain address (…workers.dev)",
    passwordPlaceholder: "Your password",
    connect: "Connect",
    footnote:
      "The address is in Connection details on your other computer, " +
      "or in the confirmation email you sent yourself.",
  },
  password: {
    title: "Create your password",
    lede:
      "This is the key to your Second Brain. You'll use it to connect " +
      "new tools and to sign in from other computers.",
    placeholder: "Choose a password (12+ characters)",
    confirmPlaceholder: "Type it again",
    generateTitle: "Generate a strong password for me",
    tooShort: "Too short",
    checking: "Checking…",
    foundInBreaches: "Found in breaches",
    strong: "Strong",
    good: "Good",
    easyToGuess: "Easy to guess",
    breachHint:
      "This password has appeared in data breaches, so it isn't safe " +
      "to use here. Try another, or let us generate one.",
    mismatch: "Those don't match yet.",
    notice:
      "Save this somewhere safe — a password manager is perfect. " +
      "You'll need it to connect new tools later, and it can't be recovered for you.",
    footnote:
      "We check new passwords against known data breaches without ever " +
      "sending your password anywhere — only a fragment of a fingerprint " +
      "leaves this computer.",
  },
  cloudflare: {
    title: "Connect your account",
    lede:
      "Your Second Brain lives in your own private space, powered by " +
      "Cloudflare — so your memories belong to you, not to us. " +
      "Sign in, or create a free account in the same window.",
    signIn: "Sign in to create your space",
    footnote: "We never see your Cloudflare password.",
    waitingTitle: "Waiting for your browser…",
    waitingLede:
      "Finish signing in (or creating your free account) in the browser " +
      "window that just opened, then come back here.",
    watchingSignIn: "Watching for you to finish signing in",
    pickerTitle: "Which space should it live in?",
    pickerLede: "Your login has more than one — pick where your Second Brain goes.",
  },
  progress: {
    title: "Setting up your Second Brain",
    lede: "This usually takes a minute or two. Feel free to stretch.",
    stepSpace: "Creating your private space",
    stepMemory: "Building your memory store",
    stepRecall: "Turning on smart recall",
    stepFinish: "Finishing up",
  },
  tools: {
    title: "Connect your AI tools",
    lede: "Give each tool access to the same shared memory. You can always connect more later.",
    autoSetup: "Sets it up for you automatically.",
    notOnComputer: "Not found on this computer.",
    doneRestart: "Done — restart the tool to start using your Second Brain.",
    cliSub: "Use your Second Brain from the terminal.",
    setupCli: "Set up CLI",
    settingUp: "Setting up…",
    cliDone: "Done. The brain command is ready in your terminal.",
    installing: "Installing…",
    installed: "Installed ✓",
    reopenTerminal: "The brain command is ready. Reopen your terminal if it isn't found yet.",
    configSaved: "Config saved ✓",
    configSavedInstallFailed: "Config saved, but the install didn't finish. Run it yourself: ",
    configSavedNoNpm: "Config saved. Install Node.js, then run: ",
    pasteInSettings: "Copy the link, then paste it under connectors in settings.",
    claudeCode: "Claude Code",
    cursor: "Cursor",
    cliTitle: "Second Brain CLI",
    chatgpt: "ChatGPT",
    claudeWeb: "Claude (web & desktop)",
  },
  details: {
    title: "Connection details",
    lede: "Everything you need to connect a tool or another computer.",
    notSetupTitle: "Not set up yet",
    notSetupLede: "Finish setting up your Second Brain first — these details appear here afterwards.",
    addressLabel: "Your Second Brain address",
    addressDesc: "Your private web dashboard, and where you connect new tools. Save it somewhere safe.",
    mcpLabel: "Your connection link (for AI tools)",
    mcpDesc: "Paste this into any AI tool that supports connectors.",
    connectToolsTitle: "Connect your AI tools",
    connectToolsDesc:
      "Tools on this computer connect with one click. For anything else, " +
      "paste your connection link into the tool's connector settings — " +
      "it will ask for your password the first time.",
    integrationsTitle: "Integrations",
    integrationsDesc: "Bring in notes and pages from the tools you already use.",
    updateLabel: "A newer Second Brain is available ({version})",
    updateDesc:
      "Update to get the latest improvements. Your memories, password, and connected tools are kept.",
    updateButton: "Update my Second Brain",
    allSetTitle: "You're all set",
    allSetLede: "Two links to keep. You can always find them again in this app under Connection details.",
    openDashboard: "Open my Second Brain",
  },
  integrations: {
    extensionTitle: "Browser extension",
    extensionSub: "Capture any page or highlight. Paste your address and password into its setup.",
    getExtension: "Get the extension",
    obsidianTitle: "Obsidian sync",
    obsidianSub: "Keep your vault notes and your Second Brain in sync.",
    openObsidian: "Open in Obsidian",
    getPlugin: "Get the plugin",
    notionTitle: "Notion",
    notionSub: "Sync Notion pages into your memory.",
    notionConnected: "Connected.",
    notionConnectedTo: "Connected to {workspace}.",
    syncNow: "Sync now",
    syncing: "Syncing…",
    manage: "Manage",
    setupNotion: "Set up Notion",
  },
  logout: {
    button: "Log out of this computer",
    confirm: "Yes, log out",
    keep: "Keep me signed in",
    desc:
      "Your Second Brain and all its memories stay safe — this only forgets " +
      "the connection on this computer. You can reconnect anytime with " +
      "your address and password.",
  },
  workerUpdate: {
    title: "Update your Second Brain",
    ledeWithVersion:
      "A newer version of your Second Brain (version {version}) is ready to install. " +
      "Your memories, password, and connected tools are all kept — nothing is reset.",
    ledeGeneric:
      "A newer version of your Second Brain is ready to install. " +
      "Your memories, password, and connected tools are all kept — nothing is reset.",
    notice: "You'll sign in to Cloudflare once to authorize the update. It takes about a minute.",
    signInUpdate: "Sign in and update",
    waitingLede:
      "Finish signing in to Cloudflare in the browser window that just opened, then come back here.",
    updatingTitle: "Updating your Second Brain",
    updatingLede: "This usually takes a minute. Your memories are safe.",
    stepMemory: "Updating your memory store",
    stepRecall: "Refreshing smart recall",
    stepFinish: "Finishing up",
    doneTitle: "Your Second Brain is up to date",
    doneLede:
      "Everything's on the latest version — your memories, password, and connected tools are unchanged.",
  },
  email: {
    subject: "Your Second Brain details",
    bodyAddress: "Your Second Brain address (your private dashboard):",
    bodyMcp: "Your connection link (paste into AI tools that support connectors):",
  },
};
