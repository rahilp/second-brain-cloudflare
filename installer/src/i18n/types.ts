export type Locale = "en" | "it";

/** One named level of a multi-value control (#246). */
export type LevelCopy = {
  name: string;
  /** Names the downside as well as the upside — see #244 copy conventions. */
  notice: string;
};

export type Messages = {
  common: {
    continue: string;
    back: string;
    copy: string;
    copied: string;
    copyBoth: string;
    copyLink: string;
    copyAddress: string;
    copyCommand: string;
    connect: string;
    connecting: string;
    connected: string;
    openSettings: string;
    emailDetails: string;
    notNow: string;
    tryAgain: string;
    checking: string;
    ready: string;
    notFound: string;
    demoMode: string;
    appTitle: string;
  };
  settings: {
    title: string;
    language: string;
    languageDesc: string;
    english: string;
    italian: string;
  };
  settingsPanel: {
    title: string;
    lede: string;
    sectionRecall: string;
    sectionRemember: string;
    sectionAi: string;
    sectionMatching: string;
    custom: string;
    customNote: string;
    reset: string;
    save: string;
    cancel: string;
    unsaved: string;
    unsavedOne: string;
    saving: string;
    saved: string;
    loadFailed: string;
    recency: { label: string; desc: string; levels: { timeless: LevelCopy; balanced: LevelCopy; recent_first: LevelCopy } };
    variety: { label: string; desc: string; levels: { focused: LevelCopy; balanced: LevelCopy; varied: LevelCopy } };
    connections: { label: string; desc: string; levels: { off: LevelCopy; nearby: LevelCopy; extended: LevelCopy } };
    detail: { label: string; desc: string; levels: { compact: LevelCopy; standard: LevelCopy; full: LevelCopy } };
    duplicates: { label: string; desc: string; note: string; levels: { permissive: LevelCopy; standard: LevelCopy; strict: LevelCopy } };
    compression: { label: string; desc: string; note: string; levels: { conservative: LevelCopy; standard: LevelCopy; aggressive: LevelCopy } };
    model: { label: string; desc: string; sizeNote: string; neuronsNote: string };
    /**
     * The model used only when Second Brain reasons over a pair of memories to
     * draw an insight — everything `model` above covers is unaffected by this.
     */
    insightModel: { label: string; desc: string; sizeNote: string; defaultNote: string };
    /**
     * Rebuilding how memories are read (#248). The only destructive, multi-step
     * flow in this window, so it carries a screen's worth of copy per step
     * rather than one notice per level.
     */
    migration: {
      lede: string;
      label: string;
      desc: string;
      /** Three forms: "1 memory saved" is the count a real new brain shows. */
      entries: string;
      entriesOne: string;
      entriesNone: string;
      pickLabel: string;
      inUse: string;
      storageWarning: string;
      pickNote: string;
      /**
       * Named levels, keyed by the `level` each choice carries. These are the
       * only labels the picker shows — the model id is secondary text on the
       * confirm screen and nowhere else, because this is the last thing read
       * before an operation that cannot be undone.
       */
      levels: { standard: LevelCopy; finer: LevelCopy; finest: LevelCopy };
      sameAsCurrent: string;
      dirtyNote: string;
      startButton: string;
      confirmTitle: string;
      /** The one full-weight sentence on a screen that is otherwise all grey. */
      confirmLead: string;
      confirmBody: string;
      point1: string;
      point2: string;
      /** How long, expressed in rounds — the only unit that can be honest. */
      point3: string;
      point4: string;
      targetLine: string;
      /** The raw model id, for anyone who wants to audit what they picked. */
      modelLine: string;
      confirmButton: string;
      cancelButton: string;
      startingTitle: string;
      startingBody: string;
      runningTitle: string;
      runningBody: string;
      pauseButton: string;
      pausing: string;
      pausedTitle: string;
      pausedBody: string;
      progress: string;
      progressPending: string;
      skipped: string;
      stalledTitle: string;
      stalledBody: string;
      /** The other stall: one memory keeps failing, so waiting cannot help. */
      stalledFailingTitle: string;
      stalledFailingBody: string;
      resumeButton: string;
      startOverButton: string;
      startOverNote: string;
      resettingTitle: string;
      resettingBody: string;
      interruptedTitle: string;
      interruptedBody: string;
      failedTitle: string;
      failedBody: string;
      stuckTitle: string;
      stuck: string;
      doneTitle: string;
      doneBody: string;
      changeAgain: string;
      freeLabel: string;
      freeDesc: string;
      freeButton: string;
      freeConfirm: string;
      freeKeep: string;
      freeing: string;
      freeingBody: string;
      freedTitle: string;
      freedBody: string;
      loading: string;
      loadFailed: string;
      barRunning: string;
      barWorking: string;
    };
  };
  welcome: {
    title: string;
    lede: string;
    getStarted: string;
    alreadyHave: string;
    footnote: string;
  };
  /**
   * Who the fresh brain is for (v3 team edition). Both answers provision
   * identically; the fork exists so the setup can record the mode and let the
   * closing screens address the right reader.
   */
  audience: {
    title: string;
    lede: string;
    justMe: string;
    aTeam: string;
    footnote: string;
  };
  connectExisting: {
    title: string;
    lede: string;
    addressPlaceholder: string;
    passwordPlaceholder: string;
    connect: string;
    footnote: string;
    chooseLede: string;
    signInButton: string;
    signInHint: string;
    signInFootnote: string;
    manualButton: string;
    accountPickerTitle: string;
    accountPickerLede: string;
    searchingTitle: string;
    searchingLede: string;
    searchingStep: string;
    pickTitleOne: string;
    pickTitleMany: string;
    pickLedeOne: string;
    pickLedeMany: string;
    noneFound: string;
    unlockTitle: string;
    unlockLede: string;
    /** Door B into the password change (#235) — a ghost link on both screens. */
    lostPassword: string;
  };
  password: {
    title: string;
    lede: string;
    placeholder: string;
    confirmPlaceholder: string;
    generateTitle: string;
    tooShort: string;
    checking: string;
    foundInBreaches: string;
    strong: string;
    good: string;
    easyToGuess: string;
    breachHint: string;
    mismatch: string;
    notice: string;
    footnote: string;
  };
  /**
   * Changing the password on an existing Second Brain (#235). Two doors reach
   * the same sequence: a voluntary change from the Connection pane, and "I
   * don't have my password" from the connect screens.
   *
   * Every failure state in here shows the new password, because once the
   * change lands nothing can read it back — not the app, not Cloudflare. A
   * screen that reports a failure without the password on it is how someone
   * loses a brain.
   */
  changePassword: {
    // Door A intro
    title: string;
    lede: string;
    notice: string;
    signInButton: string;
    signInFootnote: string;
    waitingLede: string;
    // Blocked by a rebuild, rendered inside the Connection pane's card
    blockedTitle: string;
    blockedBody: string;
    /** An abandoned rebuild blocks this forever without a way out on screen. */
    blockedEscape: string;
    blockedButton: string;
    /**
     * Added to the blocked *screen* — never the Connection pane's card — when an
     * earlier attempt in the same window reached the brain and never confirmed.
     * Being blocked and having a password that may already be live are both
     * true at once, and the screen that drops either one is lying about the
     * other.
     */
    blockedMayBeLive: string;
    // Door B intro — one screen, two variants
    lostTitle: string;
    lostLede: string;
    lostBodySignedIn: string;
    lostBodySignIn: string;
    lostNotice: string;
    lostContinueButton: string;
    lostSignInButton: string;
    // Finding the brain again in lost mode
    pickBrainLedeOne: string;
    pickBrainLedeMany: string;
    addressTitle: string;
    addressLede: string;
    /** Same screen, reached deliberately rather than because nothing was found. */
    addressLedeManual: string;
    // Choosing the new one
    pickTitle: string;
    pickLede: string;
    generatedNote: string;
    pickNotice: string;
    // The save gate
    saveTitle: string;
    saveLede: string;
    /** The label on the password card, shared with every failure screen. */
    passwordLabel: string;
    saveAdvice: string;
    saveConfirm: string;
    saveBack: string;
    // Progress
    progressTitle: string;
    progressLede: string;
    stepSend: string;
    stepConfirm: string;
    stepLocal: string;
    // Done
    doneTitle: string;
    doneTitleLost: string;
    doneLede: string;
    doneNeedsHead: string;
    doneNeeds1: string;
    /**
     * The extension and the Obsidian plugin hold the old password on *this*
     * computer too — `persist` writes secure storage, the CLI config and the
     * open dashboard window, and nothing else — so this list is not scoped to
     * "any other computer". Door B's `lostNotice` has always said so.
     */
    doneNeeds2: string;
    doneNeeds3: string;
    doneNeeds4: string;
    doneKeptHead: string;
    doneKept: string;
    /** Conditional, not a warning: most changes are hygiene, not a leak. */
    doneLeak: string;
    doneDisconnectButton: string;
    doneShow: string;
    doneHide: string;
    // Nothing was changed
    failNotSentTitle: string;
    failNotSentBody: string;
    /** Labelled by what it actually is here: a password that is not in use. */
    failNotSentLabel: string;
    failDetail: string;
    // It may already be live — never says "failed"
    failUnsureTitle: string;
    failUnsureBody: string;
    failUnsureRetry: string;
    failUnsureFootnote: string;
    failUnsureLeave: string;
    recheckButton: string;
    recheckConfirmed: string;
    recheckUnconfirmed: string;
    /** The third answer: we could not ask, which settles nothing either way. */
    recheckUnreachable: string;
    // Changed, but not saved on this computer
    failLocalTitle: string;
    /** When secure storage took it and something else here did not, so the
     *  unconditional heading above would be untrue. */
    failLocalTitlePartial: string;
    failLocalBody: string;
    failLocalCli: string;
    failLocalDashboard: string;
    failLocalReconnect: string;
    /**
     * The save gate confirms a password that is merely proposed. By the time a
     * failure screen renders, the same password may already be the only key to
     * the brain — so the exits from those screens get the same acknowledgement.
     */
    leaveWarn: string;
    leaveConfirm: string;
    leaveKeep: string;
  };
  /** The other machines, holding a password that was replaced elsewhere (#235 §5). */
  passwordChangedElsewhere: {
    title: string;
    lede: string;
    body: string;
    findAgain: string;
    findAgainHint: string;
    footnote: string;
  };
  cloudflare: {
    title: string;
    lede: string;
    signIn: string;
    footnote: string;
    waitingTitle: string;
    waitingLede: string;
    watchingSignIn: string;
    pickerTitle: string;
    pickerLede: string;
  };
  progress: {
    title: string;
    lede: string;
    stepSpace: string;
    stepMemory: string;
    stepRecall: string;
    stepFinish: string;
  };
  tools: {
    title: string;
    lede: string;
    autoSetup: string;
    notOnComputer: string;
    doneRestart: string;
    cliSub: string;
    setupCli: string;
    settingUp: string;
    cliDone: string;
    installing: string;
    installed: string;
    reopenTerminal: string;
    configSaved: string;
    configSavedInstallFailed: string;
    configSavedNoNpm: string;
    pasteInSettings: string;
    claudeCode: string;
    cursor: string;
    cliTitle: string;
    chatgpt: string;
    claudeWeb: string;
  };
  details: {
    title: string;
    lede: string;
    notSetupTitle: string;
    notSetupLede: string;
    addressLabel: string;
    addressDesc: string;
    mcpLabel: string;
    mcpDesc: string;
    /**
     * The password card in the Connection pane. It has no value and no Copy
     * button, unlike the two cards above it, so the description explains the
     * absence rather than leaving it to be inferred.
     */
    passwordLabel: string;
    passwordDesc: string;
    passwordButton: string;
    /**
     * Disconnecting every AI tool (#235 §6). Deliberately not part of changing
     * the password: tools that went through the connection link hold their own
     * access and never used the password, so a rotation does not reach them.
     */
    disconnectLabel: string;
    disconnectDesc: string;
    disconnectButton: string;
    disconnectConfirmDesc: string;
    disconnectConfirm: string;
    disconnectKeep: string;
    disconnectWorking: string;
    disconnectDone: string;
    disconnectDoneNone: string;
    disconnectFailed: string;
    connectToolsTitle: string;
    connectToolsDesc: string;
    integrationsTitle: string;
    integrationsDesc: string;
    navConnection: string;
    navTools: string;
    navIntegrations: string;
    navComputer: string;
    updateLabel: string;
    updateDesc: string;
    updateButton: string;
    allSetTitle: string;
    allSetLede: string;
    /** Team setups only: replaces allSetLede, and the team card below appears. */
    allSetTeamLede: string;
    teamCardLabel: string;
    teamCardBody: string;
    openDashboard: string;
  };
  integrations: {
    extensionTitle: string;
    extensionSub: string;
    getExtension: string;
    obsidianTitle: string;
    obsidianSub: string;
    openObsidian: string;
    getPlugin: string;
    connectedPlain: string;
    connectedTo: string;
    syncNow: string;
    syncing: string;
    manage: string;
    setUp: string;
    appsTitle: string;
    back: string;
    categoryKnowledge: string;
    categoryCalendar: string;
    categoryEmail: string;
    categoryOther: string;
  };
  logout: {
    button: string;
    confirm: string;
    keep: string;
    desc: string;
  };
  workerUpdate: {
    title: string;
    ledeWithVersion: string;
    ledeGeneric: string;
    notice: string;
    signInUpdate: string;
    waitingLede: string;
    updatingTitle: string;
    updatingLede: string;
    stepMemory: string;
    stepRecall: string;
    stepFinish: string;
    doneTitle: string;
    doneLede: string;
  };
  email: {
    subject: string;
    bodyAddress: string;
    bodyMcp: string;
  };
};
