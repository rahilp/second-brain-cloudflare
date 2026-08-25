// Dashboard i18n (en / it). Same storage key as the desktop installer.
// Classic script: exposes t, tPlural, initI18n, applyI18nDom, getLocale, localeTag, formatDateUI.

const SB_LOCALE_KEY = 'sb-locale'

const I18N_EN = {
  auth: {
    brand: 'Second Brain',
    subtitle:
      'Enter your Bearer token to connect to your personal memory layer. This is the password you chose when you set up Second Brain.',
    tokenPlaceholder: 'Bearer token (your setup password)',
    connect: 'Connect',
    connecting: 'Connecting...',
    connectingEllipsis: 'Connecting…',
    fillBoth: 'Please fill in both fields.',
    invalidToken: 'Invalid token',
    couldNotConnect: 'Could not connect.',
    serverError: 'Server error: {status}',
  },
  nav: {
    home: 'Home',
    memories: 'Memories',
    team: 'Team',
    refresh: 'Refresh',
    settings: 'Settings',
    statusEmpty: 'always remembers',
    statusCount: {
      one: '{n} memory stored',
      other: '{n} memories stored',
    },
  },
  home: {
    greetingDefault: 'Hello',
    greetingStillUp: 'Still up',
    greetingMorning: 'Good morning',
    greetingAfternoon: 'Good afternoon',
    greetingEvening: 'Good evening',
    greetingLate: 'Late one',
    placeholder: 'Ask, or tell me something to remember',
    modeTitle: 'Switch between asking and remembering',
    willSearch: 'will search',
    willRemember: 'will remember',
    hintHtml: 'Add <span class="hashtag">#tags</span> anywhere to file it',
    subMemory: { one: '{n} memory', other: '{n} memories' },
    subThisWeek: '{n} this week',
    askAbout: 'What did I decide about {tag}?',
    receiptAlreadyKept: 'already kept',
    receiptAlreadyKeptNote: 'Something very similar is already in your brain, so this was skipped.',
    receiptCouldNotSave: 'could not save',
    receiptCouldNotSaveNote: 'Nothing was lost — the text is still in the box. Try again.',
    receiptStored: 'stored to brain',
    receiptMerged: 'merged into an existing memory',
    receiptMergedNote: 'You had written about this before, so the two are now one memory.',
    receiptReplaced: 'replaced an outdated memory',
    receiptReplacedNote: 'The older version is gone; this one supersedes it.',
    receiptConflict: 'stored, and something older now disagrees',
    receiptConflictNote:
      'Your brain noticed this conflicts with an earlier memory and kept the newer one.',
    receiptDraft: 'stored as a draft',
    receiptDraftNote:
      'This conflicts with a memory you have confirmed, so it is kept unconfirmed rather than overriding it.',
    receiptSimilar: 'stored, close to something you already had',
    receiptSimilarNote: 'Flagged as a possible duplicate so you can compare them later.',
    receiptFiledUnder: 'filed under',
    firstRunEyebrow: 'Getting started',
    firstRunHero: 'Your Second Brain is empty. Here is where everything lives.',
    firstRunStep1:
      'The box above does both: write a statement and it is saved, ask a question and it is answered. It says which one it is about to do before you send.',
    firstRunStep2:
      'Memories is everything you have kept — as a list by date, or as a graph of how it connects.',
    firstRunStep3:
      'Settings is where you connect Claude, ChatGPT, Cursor, your email and calendar, so they read from and add to this same memory.',
  },
  recall: {
    eyebrow: 'Recall',
    hero: "Ask me anything you've stored away — I'll find it and answer in your own words.",
    placeholder: 'Ask your brain...',
    backHome: 'Back to home',
    allTags: 'All tags',
    sugWorkingOn: 'What am I working on?',
    sugDecidedRecently: 'What did I decide recently?',
    sugTasks: 'Show my tasks',
    sugGoals: 'What are my goals?',
    sugIdeas: 'What ideas do I have?',
    sugLastWeek: 'Last week',
    sugLastWeekQuery: 'What happened last week?',
    sugThisMonth: 'This month',
    sugThisMonthQuery: 'What did I decide this month?',
    sugOutOfDate: 'What might be out of date?',
    empty: "I couldn't find anything matching that. Try different words, or browse Memories.",
    error: 'Something went wrong. Check your connection and try again.',
    youAsked: 'You asked',
    sourcesFound: { one: 'found · {n} source', other: 'found · {n} sources' },
    citeTitle: 'Show source {n}',
    citedAs: 'Cited as [{n}] in the answer',
    relatedHop: { one: 'related · {n} hop', other: 'related · {n} hops' },
  },
  memories: {
    allTime: 'All time',
    today: 'Today',
    yesterday: 'Yesterday',
    last7: 'Last 7 days',
    last30: 'Last 30 days',
    thisMonth: 'This month',
    weekOf: 'Week of {date}',
    legend: 'Grouped by tag · tap a memory to open it',
    viewAria: 'How to view your memories',
    viewList: 'List',
    viewListTitle: 'By time',
    viewGraph: 'Graph',
    viewGraphTitle: 'By connection',
    loading: 'Loading memories...',
    loadingShort: 'Loading...',
    loadFailed: 'Could not load memories.',
    empty: 'No memories yet. Use Remember to save your first one.',
    vecOnTitle: 'Vectorized — searchable via recall',
    vecPendingTitle: 'Vectorizing… (just captured)',
    vecOffTitle: "Not vectorized — won't appear in recall",
    vecNotIndexed: 'Not indexed',
    append: 'Append',
    edit: 'Edit',
    forget: 'Forget',
    forgetThis: 'Forget this memory',
    moreActions: 'More actions',
    confirmTitle: 'Forget this memory?',
    confirmBody: "This can't be undone. The memory will be removed from your brain.",
    cancel: 'Cancel',
    appendTitle: 'Add an update',
    appendPlaceholder: "What's changed or new?",
    appendSave: 'Update',
    saving: 'Saving...',
    appendFailed: 'Append failed: {message}',
    editTitle: 'Edit memory',
    editPlaceholder: 'Edit your memory...',
    editHintHtml:
      'Tap a tag to remove it. Use <span style="font-style: italic">#hashtags</span> in the text to add one.',
    editSave: 'Save',
    editFailed: 'Edit failed: {message}',
    removeTag: 'Remove tag {tag}',
    viewTitle: 'Memory',
    forgetting: 'Forgetting...',
    forgetFailed: 'Could not forget: {message}',
    metaCaptured: 'captured {relative}',
    metaEdited: 'edited {relative}',
    brainLabel: 'What your brain knows',
    importance: 'Importance',
    importanceTitle: 'Importance {n} of 5',
    kind: 'Kind',
    status: 'Status',
    lifespan: 'Lifespan',
    recalled: 'Recalled',
    recalledTimes: { one: '{n} time', other: '{n} times' },
    kindFact: 'Fact',
    kindEvent: 'Event',
    statusTrusted: 'Trusted',
    statusUnconfirmed: 'Unconfirmed',
    statusSuperseded: 'Superseded',
    volDurable: 'Durable',
    volDurableGloss: 'Not expected to change.',
    volCurrent: 'Current',
    volCurrentGloss: 'True for now — assistants verify this before relying on it.',
    volShortLived: 'Short-lived',
    volShortLivedGloss: 'True only briefly — assistants treat it as possibly stale.',
    disagreed: {
      one: 'Something newer has disagreed with this {n} time.',
      other: 'Something newer has disagreed with this {n} times.',
    },
    notIndexedYet: 'Not indexed yet — recall cannot find this memory.',
    related: 'Related',
    youLinked: 'you linked',
    systemLinked: 'system-linked',
    autoLinked: 'auto-linked',
    removeLink: 'Remove link',
    removeLinkConfirm: 'Remove this link? The memories stay; only the connection is deleted.',
    untitled: 'Untitled memory',
  },
  graph: {
    empty: 'No connections yet — link memories, or let them auto-connect as you add more.',
    loadFailed: 'Could not load the graph.',
    zoomOut: 'Zoom out',
    zoomIn: 'Zoom in',
    fit: 'Fit to view',
    relayout: 'Re-lay out',
  },
  menu: {
    title: 'Your brain',
    groupUpkeep: 'Upkeep',
    groupData: 'Data',
    groupConnections: 'Connections',
    groupThisApp: 'This app',
    backupJson: 'Back up as JSON',
    exportMarkdown: 'Export as Markdown',
    restore: 'Restore from backup',
    integrations: 'Integrations',
    appearance: 'Appearance',
    language: 'Language',
    localeEn: 'English',
    localeIt: 'Italian',
    themeLight: 'Light',
    themeDark: 'Dark',
    themeAuto: 'Auto',
    themeMatchSystem: 'Match system',
    aboutAria: 'About Second Brain',
    about: 'About',
    createdBy: 'Created by',
    maintainers: 'Maintainers',
    disconnect: 'Disconnect',
    exportFailed: 'Export failed: {message}',
    exportMdTitle: '# Second Brain Export',
    exportMdExported: 'Exported: {date}',
    exportMdMemory: '## Memory {n}',
    exportMdDate: '**Date:** {date}',
    exportMdTags: '**Tags:** {tags}',
    exportMdSource: '**Source:** {source}',
    exportMdRelationships: '## Relationships',
  },
  upkeep: {
    working: 'Working…',
    done: 'Done',
    requestFailed: 'Request failed',
    digestLabel: 'Ready to compress',
    digestNote:
      "Originals are never deleted — digest adds a summary and ranks originals lower in recall so they don't crowd results.",
    digestEntries: { one: '{n} entry', other: '{n} entries' },
    digestAction: 'Digest →',
    digestMore: '{n} more ›',
    digestFailed: 'Could not create digest',
    digestPreserved: {
      one: '{n} original memory preserved & still searchable',
      other: '{n} original memories preserved & still searchable',
    },
    vectorizeLabel: 'Not indexed',
    vectorizeNote: {
      one: "{n} memory failed to embed and won't appear in recall.",
      other: "{n} memories failed to embed and won't appear in recall.",
    },
    vectorizeAction: 'Vectorize now →',
    vectorizeDone: 'Done — {n} re-indexed',
    classifyLabel: 'Not classified',
    classifyNote: {
      one: '{n} memory has no kind or status tag yet (captured before classification existed).',
      other: '{n} memories have no kind or status tag yet (captured before classification existed).',
    },
    classifyAction: 'Classify now →',
    classifyDone: 'Done — {n} classified',
    restoreLabel: 'Restore',
    restoreProgress: 'Restoring from {filename}…',
    restoreOf: '{done} of {total}',
    restoreTryAgain: 'Try again →',
    restoreFailureTail:
      "Your backup file is untouched, and it's safe to try again — anything already restored will be skipped, not duplicated.",
    restoreInvalidJson: "{filename} isn't valid JSON.",
    restoreNotBackup:
      "{filename} doesn't look like a Second Brain backup — it has no entries list. Use a file created by \"Back up as JSON\".",
    restoreStopped: 'The restore stopped partway.',
    restoreSummaryRestored: '{n} restored',
    restoreSummaryConnections: '{n} connections',
    restoreSummaryPresent: '{n} already present',
    restoreFailNote:
      "{n} item(s) couldn't be restored — usually rows edited by hand; the rest are unaffected.",
    restoreNeedsIndex: "Restored memories can't be searched until they're indexed.",
    restoreMakeSearchable: 'Make searchable →',
    restoreIndexing: 'Indexing…',
    restoreIndexingProgress: 'Indexing… {done} done, {remaining} to go',
    restoreIndexingDoneOnly: 'Indexing… {done} done',
    restoreQuotaLeft: '{n} left — daily AI limit reached, try tomorrow',
    restoreAllSearchable: 'All restored memories are searchable',
    restoreIndexFailed: 'Failed — tap to retry',
    importStalled: 'Server did not advance the import cursor — is the Worker up to date?',
    vectorizeBannerTitle: 'Semantic search is disabled. The Vectorize index "{name}" was not found.',
    vectorizeBannerHowToFix: 'How to fix',
    vectorizeBannerRunOnce: 'Run this once in your terminal:',
    vectorizeBannerGui:
      'Or grant the Workers Builds API token the account-level Vectorize Edit permission in the Cloudflare dashboard (My Profile, API Tokens), then redeploy so the build creates the index automatically.',
  },
  integrations: {
    intro:
      'Connect the tools where your context already lives. Synced content stays up to date and surfaces in recall like any other memory.',
    loading: 'Loading…',
    backSettings: 'Back to settings',
    backList: 'Back to integrations',
    loadFailed: 'Could not load integrations.',
    none: 'No integrations available.',
    emptyCategory: 'Nothing here yet.',
    categoryKnowledge: 'Knowledge',
    categoryCalendars: 'Calendars',
    categoryEmail: 'Email',
    categoryOther: 'Other',
    summaryConnected: { one: '{n} connected', other: '{n} connected' },
    notConnected: 'Not connected',
    connected: 'Connected',
    pasteSecret: 'Paste your secret',
    emailPlaceholder: 'you@example.com',
    emailAria: 'Email address',
    appPassword: 'app password',
    appPasswordAria: 'App password',
    notionPlaceholder: 'Integration secret (ntn_…)',
    urlPlaceholder: 'https://…',
    notionHint:
      'Create an internal <strong>connection</strong> (not a personal access token) at <a href="https://app.notion.com/developers/connections" target="_blank" rel="noopener">app.notion.com/developers/connections</a>, share the pages you want synced with that connection, then paste its secret here.',
    needEmailPw: 'Enter your email and app password.',
    needSecret: 'Paste your secret first.',
    couldNotConnectShort: 'Could not connect',
    syncNow: 'Sync now',
    syncing: 'Syncing…',
    syncingProgress: 'Syncing… {n} {noun} so far',
    synced: { one: '{n} synced', other: '{n} synced' },
    syncFailed: 'Sync failed',
    lastSyncFailed: 'Last sync failed: {error}',
    countSynced: { one: '{n} {noun} synced', other: '{n} {noun} synced' },
    lastSync: 'Last sync: {when}',
    never: 'never',
    disconnectConfirm: 'Disconnect {name}? It will stop syncing.',
    purgeConfirm: {
      one: 'Also delete the {n} synced {noun}?\n\nOK = delete them\nCancel = keep them as regular memories',
      other: 'Also delete the {n} synced {noun}?\n\nOK = delete them\nCancel = keep them as regular memories',
    },
    disconnecting: 'Disconnecting…',
    disconnectFailed: 'Disconnect failed',
    nounEvent: { one: 'event', other: 'events' },
    nounEmail: { one: 'email', other: 'emails' },
    nounItem: { one: 'item', other: 'items' },
    nounMemory: { one: 'memory', other: 'memories' },
    connect: {
      'calendar-google': {
        label: 'Paste your Google Calendar secret iCal URL',
        placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics',
        hint:
          'In Google Calendar (web): Settings → your calendar → <b>Integrate calendar</b> → copy the <b>"Secret address in iCal format"</b>. Keep it private — anyone with it can read the calendar.',
      },
      'calendar-outlook': {
        label: 'Paste your Outlook published ICS URL',
        placeholder: 'https://outlook.live.com/owa/calendar/…/calendar.ics',
        hint:
          'In Outlook.com: Settings → Calendar → <b>Shared calendars</b> → Publish a calendar → publish, then copy the <b>ICS</b> link. (Work/school accounts may have publishing disabled.)',
      },
      'calendar-icloud': {
        label: 'Paste your iCloud shared calendar URL',
        placeholder: 'webcal://p…-caldav.icloud.com/published/…',
        hint:
          'In Calendar (Mac or iCloud.com): right-click the calendar → <b>Share Calendar</b> → enable <b>Public Calendar</b> → copy the webcal link.',
      },
      'email-gmail': {
        label: 'Connect your Gmail inbox',
        placeholder: '16-character app password',
        hint:
          'In your Google Account → Security → 2-Step Verification → <b>App passwords</b>, create one for Mail, then enter your Gmail address and that password. (Requires 2-Step Verification; IMAP must be enabled in Gmail settings.)',
      },
      'email-icloud': {
        label: 'Connect your iCloud inbox',
        placeholder: 'app-specific password',
        hint:
          'At appleid.apple.com → Sign-In and Security → <b>App-Specific Passwords</b>, generate one, then enter your iCloud email and that password.',
      },
    },
  },
  team: {
    title: 'Team',
    membersLabel: 'Members',
    adminsOnly: 'Only workspace admins can manage team members.',
    roleAdmin: 'Admin',
    roleMember: 'Member',
    you: 'you',
    suspendedChip: 'suspended',
    privateEntries: { one: '{n} private entry', other: '{n} private entries' },
    rotateToken: 'Rotate token',
    suspend: 'Suspend',
    restore: 'Restore',
    rotateConfirm:
      'Issue a fresh sign-in token for {name}? Their current token stops working once the new one is used.',
    suspendConfirm: 'Suspend {name}? They lose access immediately.',
    restoreConfirm: 'Restore access for {name}?',
    addTitle: 'Add member',
    namePlaceholder: 'Name',
    emailPlaceholder: 'Email (optional)',
    addAction: 'Add member',
    adding: 'Adding…',
    needName: 'Give the member a name first.',
    duplicateEmail: 'That email already belongs to a member.',
    actionFailed: 'That did not work. Try again.',
    tokenTitle: 'One-time sign-in token',
    tokenFor: 'for {name}',
    tokenWarning: 'Copy it now — you will not see this again.',
    copy: 'Copy',
    copied: 'Copied',
    done: 'Done',
  },
  brief: {
    eyebrow: 'Your brain, lately',
    lastDays: 'Last {n} days',
    whereFrom: 'Where from',
    activityTitle: {
      one: '{date}: {n} memory',
      other: '{date}: {n} memories',
    },
    attentionUnindexed: '{n} not searchable',
    attentionStale: '{n} may be out of date',
    patternNoticed: 'Insight noticed',
    confirm: 'Confirm',
    dismiss: 'Dismiss',
    confirmed: 'Confirmed — now recallable',
    dismissed: 'Dismissed',
    failedRetry: 'Failed — retry',
    worthRereading: 'Worth re-reading',
    fromDate: '· from {date}',
    shapeSuffix: ' · {shape}',
    moreInsights: {
      one: '{n} more insight waiting →',
      other: '{n} more insights waiting →',
    },
    moreInsightsGeneric: 'More insights are waiting →',
  },
  stale: {
    title: 'May be out of date',
    intro:
      'These were true when you wrote them and carry a claim that ages. Update one to confirm it, add to it, or forget it. Editing or appending clears the flag, because the memory has just been confirmed by the act of touching it.',
    empty: 'Nothing looks out of date.',
    loadFailed: 'Could not load what may be out of date.',
    lastConfirmed: 'Last confirmed {date}',
    more: '{n} more',
  },
  patterns: {
    title: 'Insights noticed',
    intro:
      'Your brain drew these by connecting two memories written months apart. Confirm one to make it a trusted, recallable fact; dismiss to discard it. Nothing here is searchable until you confirm it.',
    selectAll: 'Select all',
    nSelected: '{n} selected',
    confirmN: 'Confirm {n}',
    dismissN: 'Dismiss {n}',
    loadFailed: 'Could not load your insights.',
    emptyIntro: 'Nothing is waiting on you.',
    emptyBody: 'Every insight your brain drew has been ruled on.',
    noticedWhen: 'noticed {date}',
    sourceGone: 'This memory is no longer in your brain.',
    more: '{n} more ›',
    failed: 'Failed',
    upkeepNote: {
      one: '{n} insight is waiting on a decision. It stays out of recall until confirmed.',
      other: '{n} insights are waiting on a decision. They stay out of recall until confirmed.',
    },
    reviewOne: 'Review it →',
    reviewAll: 'Review all →',
    shapes: {
      contradiction: 'Contradiction',
      throughline: 'Throughline',
      connection: 'Connection',
    },
  },
  download: {
    mac: 'Download for Mac',
    windows: 'Download for Windows',
    generic: 'Download the app',
    withTag: '{label} ({tag})',
  },
  common: {
    cancel: 'Cancel',
    justNow: 'just now',
    minutesAgo: '{n}m ago',
    hoursAgo: '{n}h ago',
    daysAgo: '{n}d ago',
    weeksAgo: '{n}w ago',
    monthsAgo: '{n}mo ago',
    yearsAgo: '{n}y ago',
    sourceManual: 'manual',
    sourceCli: 'cli',
    sourceEmail: 'email',
    sourceChat: 'chat',
    sourceBrowser: 'browser',
    sourceDashboard: 'dashboard',
    sourcePhone: 'phone',
    sourceVoice: 'voice',
    sourceImport: 'import',
    sourceSystem: 'system',
    sourceClaudeCode: 'claude code',
    invalidResponse: 'Invalid response',
    mcpError: 'MCP error',
  },
}

const I18N_IT = {
  auth: {
    brand: 'Second Brain',
    subtitle:
      'Inserisci il token di accesso per collegarti al tuo livello di memoria personale. È la password scelta durante la configurazione di Second Brain.',
    tokenPlaceholder: 'Token di accesso (la password di setup)',
    connect: 'Connetti',
    connecting: 'Connessione...',
    connectingEllipsis: 'Connessione…',
    fillBoth: 'Compila entrambi i campi.',
    invalidToken: 'Token non valido',
    couldNotConnect: 'Impossibile connettersi.',
    serverError: 'Errore del server: {status}',
  },
  nav: {
    home: 'Inizio',
    memories: 'Ricordi',
    team: 'Team',
    refresh: 'Aggiorna',
    settings: 'Impostazioni',
    statusEmpty: 'ricorda sempre',
    statusCount: {
      one: '{n} ricordo salvato',
      other: '{n} ricordi salvati',
    },
  },
  home: {
    greetingDefault: 'Ciao',
    greetingStillUp: 'Ancora sveglio',
    greetingMorning: 'Buongiorno',
    greetingAfternoon: 'Buon pomeriggio',
    greetingEvening: 'Buonasera',
    greetingLate: 'Notte fonda',
    placeholder: 'Chiedi, oppure dimmi qualcosa da ricordare',
    modeTitle: 'Passa tra chiedere e ricordare',
    willSearch: 'cercherà',
    willRemember: 'ricorderà',
    hintHtml: 'Aggiungi <span class="hashtag">#tag</span> ovunque per archiviarlo',
    subMemory: { one: '{n} ricordo', other: '{n} ricordi' },
    subThisWeek: '{n} questa settimana',
    askAbout: 'Cosa ho deciso su {tag}?',
    receiptAlreadyKept: 'già presente',
    receiptAlreadyKeptNote: 'Qualcosa di molto simile è già nel tuo cervello, quindi è stato saltato.',
    receiptCouldNotSave: 'salvataggio non riuscito',
    receiptCouldNotSaveNote: 'Non è andato perso nulla — il testo è ancora nel riquadro. Riprova.',
    receiptStored: 'salvato nel cervello',
    receiptMerged: 'unito a un ricordo esistente',
    receiptMergedNote: 'Ne avevi già scritto: ora i due sono un solo ricordo.',
    receiptReplaced: 'ha sostituito un ricordo obsoleto',
    receiptReplacedNote: 'La versione precedente non c’è più; questa la sostituisce.',
    receiptConflict: 'salvato, e qualcosa di più vecchio ora non coincide',
    receiptConflictNote:
      'Il cervello ha notato un conflitto con un ricordo precedente e ha tenuto quello più recente.',
    receiptDraft: 'salvato come bozza',
    receiptDraftNote:
      'È in conflitto con un ricordo che hai confermato, quindi resta non confermato invece di sovrascriverlo.',
    receiptSimilar: 'salvato, vicino a qualcosa che avevi già',
    receiptSimilarNote: 'Segnato come possibile duplicato così puoi confrontarli più tardi.',
    receiptFiledUnder: 'archiviato sotto',
    firstRunEyebrow: 'Per iniziare',
    firstRunHero: 'Il tuo Second Brain è vuoto. Qui vive tutto.',
    firstRunStep1:
      'Il riquadro sopra fa entrambe le cose: scrivi un’affermazione e viene salvata, fai una domanda e viene risposta. Indica quale sta per fare prima di inviare.',
    firstRunStep2:
      'Ricordi è tutto ciò che hai tenuto — come elenco per data, o come grafo di come si collega.',
    firstRunStep3:
      'Impostazioni è dove colleghi Claude, ChatGPT, Cursor, email e calendario, così leggono e aggiungono a questa stessa memoria.',
  },
  recall: {
    eyebrow: 'Richiamo',
    hero: 'Chiedimi qualsiasi cosa tu abbia messo da parte — la trovo e rispondo con le tue parole.',
    placeholder: 'Chiedi al tuo cervello...',
    backHome: 'Torna alla home',
    allTags: 'Tutti i tag',
    sugWorkingOn: 'A cosa sto lavorando?',
    sugDecidedRecently: 'Cosa ho deciso di recente?',
    sugTasks: 'Mostra le mie attività',
    sugGoals: 'Quali sono i miei obiettivi?',
    sugIdeas: 'Che idee ho?',
    sugLastWeek: 'La settimana scorsa',
    sugLastWeekQuery: 'Cosa è successo la settimana scorsa?',
    sugThisMonth: 'Questo mese',
    sugThisMonthQuery: 'Cosa ho deciso questo mese?',
    sugOutOfDate: 'Cosa potrebbe essere datato?',
    empty: 'Non ho trovato nulla di corrispondente. Prova altre parole, oppure sfoglia Ricordi.',
    error: 'Qualcosa è andato storto. Controlla la connessione e riprova.',
    youAsked: 'Hai chiesto',
    sourcesFound: { one: 'trovato · {n} fonte', other: 'trovato · {n} fonti' },
    citeTitle: 'Mostra fonte {n}',
    citedAs: 'Citato come [{n}] nella risposta',
    relatedHop: { one: 'correlato · {n} salto', other: 'correlato · {n} salti' },
  },
  memories: {
    allTime: 'Tutto il tempo',
    today: 'Oggi',
    yesterday: 'Ieri',
    last7: 'Ultimi 7 giorni',
    last30: 'Ultimi 30 giorni',
    thisMonth: 'Questo mese',
    weekOf: 'Settimana del {date}',
    legend: 'Raggruppati per tag · tocca un ricordo per aprirlo',
    viewAria: 'Come vedere i tuoi ricordi',
    viewList: 'Elenco',
    viewListTitle: 'Per tempo',
    viewGraph: 'Grafo',
    viewGraphTitle: 'Per connessione',
    loading: 'Caricamento ricordi...',
    loadingShort: 'Caricamento...',
    loadFailed: 'Impossibile caricare i ricordi.',
    empty: 'Nessun ricordo ancora. Usa Ricorda per salvarne il primo.',
    vecOnTitle: 'Vettorializzato — ricercabile nel richiamo',
    vecPendingTitle: 'Vettorializzazione… (appena catturato)',
    vecOffTitle: 'Non vettorializzato — non apparirà nel richiamo',
    vecNotIndexed: 'Non indicizzato',
    append: 'Aggiungi',
    edit: 'Modifica',
    forget: 'Dimentica',
    forgetThis: 'Dimentica questo ricordo',
    moreActions: 'Altre azioni',
    confirmTitle: 'Dimenticare questo ricordo?',
    confirmBody: 'Questa azione non si può annullare. Il ricordo verrà rimosso dal cervello.',
    cancel: 'Annulla',
    appendTitle: 'Aggiungi un aggiornamento',
    appendPlaceholder: 'Cosa è cambiato o di nuovo?',
    appendSave: 'Aggiorna',
    saving: 'Salvataggio...',
    appendFailed: 'Aggiunta non riuscita: {message}',
    editTitle: 'Modifica ricordo',
    editPlaceholder: 'Modifica il ricordo...',
    editHintHtml:
      'Tocca un tag per rimuoverlo. Usa <span style="font-style: italic">#hashtag</span> nel testo per aggiungerne uno.',
    editSave: 'Salva',
    editFailed: 'Modifica non riuscita: {message}',
    removeTag: 'Rimuovi tag {tag}',
    viewTitle: 'Ricordo',
    forgetting: 'Eliminazione...',
    forgetFailed: 'Impossibile dimenticare: {message}',
    metaCaptured: 'catturato {relative}',
    metaEdited: 'modificato {relative}',
    brainLabel: 'Cosa sa il tuo cervello',
    importance: 'Importanza',
    importanceTitle: 'Importanza {n} su 5',
    kind: 'Tipo',
    status: 'Stato',
    lifespan: 'Durata',
    recalled: 'Richiamato',
    recalledTimes: { one: '{n} volta', other: '{n} volte' },
    kindFact: 'Fatto',
    kindEvent: 'Evento',
    statusTrusted: 'Affidabile',
    statusUnconfirmed: 'Non confermato',
    statusSuperseded: 'Sostituito',
    volDurable: 'Durevole',
    volDurableGloss: 'Non dovrebbe cambiare.',
    volCurrent: 'Attuale',
    volCurrentGloss: 'Vero per ora — gli assistenti lo verificano prima di farci affidamento.',
    volShortLived: 'Effimero',
    volShortLivedGloss: 'Vero solo per poco — gli assistenti lo trattano come possibilmente datato.',
    disagreed: {
      one: 'Qualcosa di più recente è in disaccordo con questo {n} volta.',
      other: 'Qualcosa di più recente è in disaccordo con questo {n} volte.',
    },
    notIndexedYet: 'Non ancora indicizzato — il richiamo non può trovare questo ricordo.',
    related: 'Correlati',
    youLinked: 'collegato da te',
    systemLinked: 'collegato dal sistema',
    autoLinked: 'collegato automaticamente',
    removeLink: 'Rimuovi collegamento',
    removeLinkConfirm:
      'Rimuovere questo collegamento? I ricordi restano; viene eliminata solo la connessione.',
    untitled: 'Ricordo senza titolo',
  },
  graph: {
    empty:
      'Ancora nessuna connessione — collega i ricordi, oppure lasciali auto-collegare man mano che ne aggiungi.',
    loadFailed: 'Impossibile caricare il grafo.',
    zoomOut: 'Riduci zoom',
    zoomIn: 'Aumenta zoom',
    fit: 'Adatta alla vista',
    relayout: 'Ridisponi',
  },
  menu: {
    title: 'Il tuo cervello',
    groupUpkeep: 'Manutenzione',
    groupData: 'Dati',
    groupConnections: 'Connessioni',
    groupThisApp: 'Questa app',
    backupJson: 'Backup come JSON',
    exportMarkdown: 'Esporta come Markdown',
    restore: 'Ripristina da backup',
    integrations: 'Integrazioni',
    appearance: 'Aspetto',
    language: 'Lingua',
    localeEn: 'Inglese',
    localeIt: 'Italiano',
    themeLight: 'Chiaro',
    themeDark: 'Scuro',
    themeAuto: 'Automatico',
    themeMatchSystem: 'Come il sistema',
    aboutAria: 'Informazioni su Second Brain',
    about: 'Informazioni',
    createdBy: 'Creato da',
    maintainers: 'Manutentori',
    disconnect: 'Disconnetti',
    exportFailed: 'Esportazione non riuscita: {message}',
    exportMdTitle: '# Esportazione Second Brain',
    exportMdExported: 'Esportato: {date}',
    exportMdMemory: '## Ricordo {n}',
    exportMdDate: '**Data:** {date}',
    exportMdTags: '**Tag:** {tags}',
    exportMdSource: '**Fonte:** {source}',
    exportMdRelationships: '## Relazioni',
  },
  upkeep: {
    working: 'In corso…',
    done: 'Fatto',
    requestFailed: 'Richiesta non riuscita',
    digestLabel: 'Pronto da comprimere',
    digestNote:
      'Gli originali non vengono mai cancellati — il riepilogo aggiunge una sintesi e abbassa gli originali nel richiamo così non affollano i risultati.',
    digestEntries: { one: '{n} voce', other: '{n} voci' },
    digestAction: 'Riepilogo →',
    digestMore: 'altre {n} ›',
    digestFailed: 'Impossibile creare il riepilogo',
    digestPreserved: {
      one: '{n} ricordo originale conservato e ancora ricercabile',
      other: '{n} ricordi originali conservati e ancora ricercabili',
    },
    vectorizeLabel: 'Non indicizzati',
    vectorizeNote: {
      one: '{n} ricordo non è stato incorporato e non apparirà nel richiamo.',
      other: '{n} ricordi non sono stati incorporati e non appariranno nel richiamo.',
    },
    vectorizeAction: 'Vettorializza ora →',
    vectorizeDone: 'Fatto — {n} reindicizzati',
    classifyLabel: 'Non classificati',
    classifyNote: {
      one: '{n} ricordo non ha ancora tipo o stato (catturato prima della classificazione).',
      other: '{n} ricordi non hanno ancora tipo o stato (catturati prima della classificazione).',
    },
    classifyAction: 'Classifica ora →',
    classifyDone: 'Fatto — {n} classificati',
    restoreLabel: 'Ripristino',
    restoreProgress: 'Ripristino da {filename}…',
    restoreOf: '{done} di {total}',
    restoreTryAgain: 'Riprova →',
    restoreFailureTail:
      'Il file di backup è intatto ed è sicuro riprovare — ciò che è già ripristinato verrà saltato, non duplicato.',
    restoreInvalidJson: '{filename} non è JSON valido.',
    restoreNotBackup:
      '{filename} non sembra un backup di Second Brain — non ha un elenco di voci. Usa un file creato con «Backup come JSON».',
    restoreStopped: 'Il ripristino si è fermato a metà.',
    restoreSummaryRestored: '{n} ripristinati',
    restoreSummaryConnections: '{n} connessioni',
    restoreSummaryPresent: '{n} già presenti',
    restoreFailNote:
      '{n} elemento/i non ripristinabili — di solito righe modificate a mano; il resto non è influenzato.',
    restoreNeedsIndex: 'I ricordi ripristinati non si possono cercare finché non sono indicizzati.',
    restoreMakeSearchable: 'Rendi ricercabili →',
    restoreIndexing: 'Indicizzazione…',
    restoreIndexingProgress: 'Indicizzazione… {done} fatti, {remaining} rimanenti',
    restoreIndexingDoneOnly: 'Indicizzazione… {done} fatti',
    restoreQuotaLeft: '{n} rimasti — limite AI giornaliero raggiunto, riprova domani',
    restoreAllSearchable: 'Tutti i ricordi ripristinati sono ricercabili',
    restoreIndexFailed: 'Non riuscito — tocca per riprovare',
    importStalled: 'Il server non ha avanzato il cursore di importazione — il Worker è aggiornato?',
    vectorizeBannerTitle:
      'La ricerca semantica è disattivata. L’indice Vectorize «{name}» non è stato trovato.',
    vectorizeBannerHowToFix: 'Come risolvere',
    vectorizeBannerRunOnce: 'Esegui questo una volta nel terminale:',
    vectorizeBannerGui:
      'Oppure concedi al token API Workers Builds il permesso Vectorize Edit a livello account nella dashboard Cloudflare (Il mio profilo, Token API), poi ridistribuisci così la build crea l’indice automaticamente.',
  },
  integrations: {
    intro:
      'Collega gli strumenti dove vive già il tuo contesto. I contenuti sincronizzati restano aggiornati e emergono nel richiamo come qualsiasi altro ricordo.',
    loading: 'Caricamento…',
    backSettings: 'Torna alle impostazioni',
    backList: 'Torna alle integrazioni',
    loadFailed: 'Impossibile caricare le integrazioni.',
    none: 'Nessuna integrazione disponibile.',
    emptyCategory: 'Ancora nulla qui.',
    categoryKnowledge: 'Conoscenza',
    categoryCalendars: 'Calendari',
    categoryEmail: 'Email',
    categoryOther: 'Altro',
    summaryConnected: { one: '{n} collegata', other: '{n} collegate' },
    notConnected: 'Non collegata',
    connected: 'Collegata',
    pasteSecret: 'Incolla il segreto',
    emailPlaceholder: 'tu@esempio.com',
    emailAria: 'Indirizzo email',
    appPassword: 'password app',
    appPasswordAria: 'Password app',
    notionPlaceholder: 'Segreto integrazione (ntn_…)',
    urlPlaceholder: 'https://…',
    notionHint:
      'Crea una <strong>connessione</strong> interna (non un token di accesso personale) su <a href="https://app.notion.com/developers/connections" target="_blank" rel="noopener">app.notion.com/developers/connections</a>, condividi le pagine da sincronizzare con quella connessione, poi incolla qui il segreto.',
    needEmailPw: 'Inserisci email e password app.',
    needSecret: 'Incolla prima il segreto.',
    couldNotConnectShort: 'Connessione non riuscita',
    syncNow: 'Sincronizza ora',
    syncing: 'Sincronizzazione…',
    syncingProgress: 'Sincronizzazione… {n} {noun} finora',
    synced: { one: '{n} sincronizzato', other: '{n} sincronizzati' },
    syncFailed: 'Sincronizzazione non riuscita',
    lastSyncFailed: 'Ultima sincronizzazione non riuscita: {error}',
    countSynced: { one: '{n} {noun} sincronizzato', other: '{n} {noun} sincronizzati' },
    lastSync: 'Ultima sincronizzazione: {when}',
    never: 'mai',
    disconnectConfirm: 'Disconnettere {name}? Smetterà di sincronizzare.',
    purgeConfirm: {
      one: 'Eliminare anche il {n} {noun} sincronizzato?\n\nOK = eliminali\nAnnulla = tienili come ricordi normali',
      other: 'Eliminare anche i {n} {noun} sincronizzati?\n\nOK = eliminali\nAnnulla = tienili come ricordi normali',
    },
    disconnecting: 'Disconnessione…',
    disconnectFailed: 'Disconnessione non riuscita',
    nounEvent: { one: 'evento', other: 'eventi' },
    nounEmail: { one: 'email', other: 'email' },
    nounItem: { one: 'elemento', other: 'elementi' },
    nounMemory: { one: 'ricordo', other: 'ricordi' },
    connect: {
      'calendar-google': {
        label: 'Incolla l’URL iCal segreto di Google Calendar',
        placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics',
        hint:
          'In Google Calendar (web): Impostazioni → il tuo calendario → <b>Integra calendario</b> → copia l’<b>«Indirizzo segreto in formato iCal»</b>. Tienilo privato — chiunque lo abbia può leggere il calendario.',
      },
      'calendar-outlook': {
        label: 'Incolla l’URL ICS pubblicato di Outlook',
        placeholder: 'https://outlook.live.com/owa/calendar/…/calendar.ics',
        hint:
          'In Outlook.com: Impostazioni → Calendario → <b>Calendari condivisi</b> → Pubblica un calendario → pubblica, poi copia il link <b>ICS</b>. (Account aziendali/scolastici potrebbero disabilitare la pubblicazione.)',
      },
      'calendar-icloud': {
        label: 'Incolla l’URL del calendario iCloud condiviso',
        placeholder: 'webcal://p…-caldav.icloud.com/published/…',
        hint:
          'In Calendario (Mac o iCloud.com): clic con il tasto destro sul calendario → <b>Condividi calendario</b> → attiva <b>Calendario pubblico</b> → copia il link webcal.',
      },
      'email-gmail': {
        label: 'Collega la posta Gmail',
        placeholder: 'password per app di 16 caratteri',
        hint:
          'Nel tuo Account Google → Sicurezza → Verifica in due passaggi → <b>Password per le app</b>, crea una per Mail, poi inserisci l’indirizzo Gmail e quella password. (Richiede la verifica in due passaggi; IMAP deve essere attivo in Gmail.)',
      },
      'email-icloud': {
        label: 'Collega la posta iCloud',
        placeholder: 'password specifica per l’app',
        hint:
          'Su appleid.apple.com → Accesso e sicurezza → <b>Password specifiche per le app</b>, genera una, poi inserisci l’email iCloud e quella password.',
      },
    },
  },
  team: {
    title: 'Team',
    membersLabel: 'Membri',
    adminsOnly: 'Solo gli amministratori possono gestire i membri del team.',
    roleAdmin: 'Amministratore',
    roleMember: 'Membro',
    you: 'tu',
    suspendedChip: 'sospeso',
    privateEntries: { one: '{n} voce privata', other: '{n} voci private' },
    rotateToken: 'Ruota token',
    suspend: 'Sospendi',
    restore: 'Ripristina',
    rotateConfirm:
      'Emettere un nuovo token di accesso per {name}? Il token attuale smetterà di funzionare quando quello nuovo verrà usato.',
    suspendConfirm: 'Sospendere {name}? Perderà l’accesso immediatamente.',
    restoreConfirm: 'Ripristinare l’accesso di {name}?',
    addTitle: 'Aggiungi membro',
    namePlaceholder: 'Nome',
    emailPlaceholder: 'Email (facoltativa)',
    addAction: 'Aggiungi membro',
    adding: 'Aggiunta…',
    needName: 'Dai prima un nome al membro.',
    duplicateEmail: 'Questa email appartiene già a un membro.',
    actionFailed: 'L’operazione non è riuscita. Riprova.',
    tokenTitle: 'Token di accesso monouso',
    tokenFor: 'per {name}',
    tokenWarning: 'Copialo ora — non lo vedrai più.',
    copy: 'Copia',
    copied: 'Copiato',
    done: 'Fatto',
  },
  brief: {
    eyebrow: 'Il tuo cervello, di recente',
    lastDays: 'Ultimi {n} giorni',
    whereFrom: 'Da dove',
    activityTitle: {
      one: '{date}: {n} ricordo',
      other: '{date}: {n} ricordi',
    },
    attentionUnindexed: '{n} non ricercabili',
    attentionStale: '{n} potrebbero essere datati',
    patternNoticed: 'Insight notato',
    confirm: 'Conferma',
    dismiss: 'Ignora',
    confirmed: 'Confermato — ora richiamabile',
    dismissed: 'Ignorato',
    failedRetry: 'Non riuscito — riprova',
    worthRereading: 'Da rileggere',
    fromDate: '· dal {date}',
    shapeSuffix: ' · {shape}',
    moreInsights: {
      one: '{n} altro insight in attesa →',
      other: '{n} altri insight in attesa →',
    },
    moreInsightsGeneric: 'Altri insight in attesa →',
  },
  stale: {
    title: 'Potrebbe non essere aggiornato',
    intro:
      'Erano veri quando li hai scritti e contengono un\'affermazione che invecchia. Aggiornane uno per confermarlo, aggiungi qualcosa o dimenticalo. Modificare o aggiungere azzera il contrassegno, perché toccare la memoria equivale a confermarla.',
    empty: 'Nulla sembra non aggiornato.',
    loadFailed: 'Impossibile caricare cosa potrebbe non essere aggiornato.',
    lastConfirmed: 'Confermato il {date}',
    more: 'Altri {n}',
  },
  patterns: {
    title: 'Insight notati',
    intro:
      'Il cervello li ha ricavati collegando due ricordi scritti a distanza di mesi. Confermane uno per renderlo un fatto affidabile e richiamabile; ignoralo per scartarlo. Nulla qui è ricercabile finché non confermi.',
    selectAll: 'Seleziona tutti',
    nSelected: '{n} selezionati',
    confirmN: 'Conferma {n}',
    dismissN: 'Ignora {n}',
    loadFailed: 'Impossibile caricare gli insight.',
    emptyIntro: 'Niente in attesa.',
    emptyBody: 'Ogni insight ricavato dal cervello è stato valutato.',
    noticedWhen: 'notato {date}',
    sourceGone: 'Questa memoria non è più nel tuo cervello.',
    more: 'altri {n} ›',
    failed: 'Non riuscito',
    upkeepNote: {
      one: '{n} insight è in attesa di una decisione. Resta fuori dal richiamo finché non è confermato.',
      other:
        '{n} insight sono in attesa di una decisione. Restano fuori dal richiamo finché non sono confermati.',
    },
    reviewOne: 'Esaminarlo →',
    reviewAll: 'Esaminarli tutti →',
    shapes: {
      contradiction: 'Contraddizione',
      throughline: 'Filo conduttore',
      connection: 'Connessione',
    },
  },
  download: {
    mac: 'Scarica per Mac',
    windows: 'Scarica per Windows',
    generic: "Scarica l'app",
    withTag: '{label} ({tag})',
  },
  common: {
    cancel: 'Annulla',
    justNow: 'adesso',
    minutesAgo: '{n}m fa',
    hoursAgo: '{n}h fa',
    daysAgo: '{n}g fa',
    weeksAgo: '{n}sett fa',
    monthsAgo: '{n}mesi fa',
    yearsAgo: '{n}a fa',
    sourceManual: 'manuale',
    sourceCli: 'cli',
    sourceEmail: 'email',
    sourceChat: 'chat',
    sourceBrowser: 'browser',
    sourceDashboard: 'dashboard',
    sourcePhone: 'telefono',
    sourceVoice: 'voce',
    sourceImport: 'import',
    sourceSystem: 'sistema',
    sourceClaudeCode: 'claude code',
    invalidResponse: 'Risposta non valida',
    mcpError: 'Errore MCP',
  },
}

const I18N_CATALOGS = { en: I18N_EN, it: I18N_IT }

let currentLocale = 'en'

function resolveI18nPath(messages, path) {
  const parts = String(path).split('.')
  let node = messages
  for (const part of parts) {
    if (node == null || typeof node !== 'object') return undefined
    node = node[part]
  }
  return typeof node === 'string' ? node : node
}

function interpolate(raw, params) {
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (_, key) =>
    params[key] != null ? String(params[key]) : `{${key}}`,
  )
}

/** Translate a dotted key. Optional `{name}` placeholders. */
function t(path, params) {
  let node = resolveI18nPath(I18N_CATALOGS[currentLocale], path)
  if (node == null) node = resolveI18nPath(I18N_CATALOGS.en, path)
  if (typeof node !== 'string') return path
  return interpolate(node, params)
}

/** Plural helper: path.one / path.other with `{n}`. */
function tPlural(path, n, params) {
  const count = Number(n) || 0
  const key = count === 1 ? `${path}.one` : `${path}.other`
  return t(key, { n: String(count), ...(params || {}) })
}

function getLocale() {
  return currentLocale
}

function localeTag() {
  return currentLocale === 'it' ? 'it-IT' : 'en-US'
}

/** UI-only dates. Do not use for LLM/chat payload serialization. */
function formatDateUI(value, options) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(localeTag(), options)
}

function formatNumberUI(n) {
  return Number(n).toLocaleString(localeTag())
}

function readStoredLocale() {
  try {
    const stored = localStorage.getItem(SB_LOCALE_KEY)
    if (stored === 'en' || stored === 'it') return stored
  } catch (_) {
    /* private mode */
  }
  const nav = (typeof navigator !== 'undefined' && navigator.language
    ? navigator.language
    : ''
  ).toLowerCase()
  if (nav.startsWith('it')) return 'it'
  return 'en'
}

function initI18n(forceLocale) {
  currentLocale =
    forceLocale === 'en' || forceLocale === 'it' ? forceLocale : readStoredLocale()
  try {
    localStorage.setItem(SB_LOCALE_KEY, currentLocale)
  } catch (_) {
    /* ignore */
  }
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = currentLocale
  }
  return currentLocale
}

function setLocale(loc) {
  if (loc !== 'en' && loc !== 'it') return
  try {
    localStorage.setItem(SB_LOCALE_KEY, loc)
  } catch (_) {
    /* ignore */
  }
  location.reload()
}

function applyLocale() {
  const loc = getLocale()
  document.querySelectorAll('#locale-toggle [data-locale-val]').forEach((b) =>
    b.classList.toggle('active', b.dataset.localeVal === loc),
  )
}

/**
 * Apply data-i18n / data-i18n-html / data-i18n-attr on elements under root.
 * data-i18n → textContent
 * data-i18n-html → innerHTML (trusted catalog strings only)
 * data-i18n-attr="placeholder|title|aria-label" with data-i18n key on same el
 */
function applyI18nDom(root) {
  const scope = root || document
  if (!scope.querySelectorAll) return
  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n')
    if (!key) return
    const attrList = el.getAttribute('data-i18n-attr')
    if (attrList) {
      const text = t(key)
      attrList.split('|').forEach((attr) => {
        const name = attr.trim()
        if (name) el.setAttribute(name, text)
      })
      return
    }
    if (el.hasAttribute('data-i18n-html')) {
      el.innerHTML = t(key)
    } else {
      el.textContent = t(key)
    }
  })
}
