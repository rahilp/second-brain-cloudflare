import type { Messages } from "./types";

export const it: Messages = {
  common: {
    back: "Indietro",
    continue: "Continua",
    copy: "Copia",
    copied: "Copiato ✓",
    copyBoth: "Copia entrambi",
    copyLink: "Copia link",
    copyAddress: "Copia indirizzo",
    copyCommand: "Copia comando",
    connect: "Collega",
    connecting: "Collegamento…",
    connected: "Collegato ✓",
    openSettings: "Apri impostazioni",
    emailDetails: "Invia per email",
    notNow: "Non ora",
    tryAgain: "Riprova",
    checking: "Verifica…",
    ready: "Pronto",
    notFound: "Non trovato",
    demoMode: "Modalità demo",
  },
  settings: {
    title: "Impostazioni",
    language: "Lingua",
    languageDesc: "Scegli come visualizzare l'app Second Brain su questo computer.",
    english: "English",
    italian: "Italiano",
  },
  welcome: {
    title: "Configura il tuo Second Brain",
    lede:
      "Una memoria privata condivisa tra tutti gli strumenti AI che usi. " +
      "Ci vogliono circa due minuti, tutto nel tuo spazio privato, " +
      "senza competenze tecniche.",
    getStarted: "Inizia",
    alreadyHave: "Hai già un Second Brain?",
    footnote: "Gratuito · I tuoi dati restano tuoi",
  },
  connectExisting: {
    title: "Collega il tuo Second Brain",
    lede:
      "Nuovo computer? Inserisci l'indirizzo e la password del Second Brain " +
      "che hai già — nulla verrà modificato o resettato.",
    addressPlaceholder: "Indirizzo Second Brain (…workers.dev)",
    passwordPlaceholder: "La tua password",
    connect: "Collega",
    footnote:
      "L'indirizzo è in Dettagli connessione sull'altro computer " +
      "o nell'email di conferma che hai inviato a te stesso.",
  },
  password: {
    title: "Crea la tua password",
    lede:
      "È la chiave del tuo Second Brain. La userai per collegare nuovi strumenti " +
      "e per accedere da altri computer.",
    placeholder: "Scegli una password (12+ caratteri)",
    confirmPlaceholder: "Ripeti la password",
    generateTitle: "Genera una password sicura per me",
    tooShort: "Troppo corta",
    checking: "Verifica…",
    foundInBreaches: "Trovata in violazioni",
    strong: "Robusta",
    good: "Buona",
    easyToGuess: "Facile da indovinare",
    breachHint:
      "Questa password è comparsa in violazioni di dati ed è insicura. " +
      "Prova un'altra o genera una nuova.",
    mismatch: "Le password non coincidono.",
    notice:
      "Salvala in un posto sicuro — un gestore password è ideale. " +
      "Ti servirà per collegare nuovi strumenti; non può essere recuperata.",
    footnote:
      "Verifichiamo le password contro violazioni note senza inviare la password: " +
      "solo un frammento di impronta lascia questo computer.",
  },
  cloudflare: {
    title: "Collega il tuo account",
    lede:
      "Il Second Brain vive nel tuo spazio privato su Cloudflare — " +
      "le tue memorie sono tue, non nostre. Accedi o crea un account gratuito.",
    signIn: "Accedi per creare il tuo spazio",
    footnote: "Non vediamo la password Cloudflare.",
    waitingTitle: "In attesa del browser…",
    waitingLede:
      "Completa l'accesso (o la creazione dell'account) nel browser aperto, " +
      "poi torna qui.",
    watchingSignIn: "In attesa che completi l'accesso",
    pickerTitle: "In quale spazio installarlo?",
    pickerLede: "Il tuo login ha più di uno — scegli dove mettere il Second Brain.",
  },
  progress: {
    title: "Configurazione del Second Brain",
    lede: "Di solito ci vuole un minuto o due. Puoi allungarti.",
    stepSpace: "Creazione dello spazio privato",
    stepMemory: "Creazione del deposito memorie",
    stepRecall: "Attivazione del richiamo intelligente",
    stepFinish: "Completamento",
  },
  tools: {
    title: "Collega i tuoi strumenti AI",
    lede: "Dai a ogni strumento accesso alla stessa memoria. Puoi aggiungere altri più tardi.",
    autoSetup: "Configurazione automatica.",
    notOnComputer: "Non trovato su questo computer.",
    doneRestart: "Fatto — riavvia lo strumento per usare il Second Brain.",
    cliSub: "Usa il Second Brain da terminale.",
    setupCli: "Configura CLI",
    settingUp: "Configurazione…",
    cliDone: "Fatto. Il comando brain è pronto nel terminale.",
    installing: "Installazione…",
    installed: "Installato ✓",
    reopenTerminal: "Il comando brain è pronto. Riapri il terminale se non lo trovi.",
    configSaved: "Config salvata ✓",
    configSavedInstallFailed: "Config salvata, ma l'installazione non è finita. Esegui: ",
    configSavedNoNpm: "Config salvata. Installa Node.js, poi esegui: ",
    pasteInSettings: "Copia il link e incollalo nei connettori nelle impostazioni.",
    claudeCode: "Claude Code",
    cursor: "Cursor",
    cliTitle: "Second Brain CLI",
    chatgpt: "ChatGPT",
    claudeWeb: "Claude (web e desktop)",
  },
  details: {
    title: "Dettagli connessione",
    lede: "Tutto ciò che serve per collegare uno strumento o un altro computer.",
    notSetupTitle: "Non ancora configurato",
    notSetupLede: "Completa prima la configurazione — i dettagli appariranno qui.",
    addressLabel: "Indirizzo del Second Brain",
    addressDesc: "La dashboard web privata e dove collegi nuovi strumenti. Salvalo.",
    mcpLabel: "Link di connessione (per strumenti AI)",
    mcpDesc: "Incollalo in qualsiasi strumento AI che supporta i connettori.",
    connectToolsTitle: "Collega i tuoi strumenti AI",
    connectToolsDesc:
      "Gli strumenti su questo computer si collegano con un clic. Per gli altri, " +
      "incolla il link di connessione nelle impostazioni del connettore — " +
      "chiederà la password la prima volta.",
    integrationsTitle: "Integrazioni",
    integrationsDesc: "Importa note e pagine dagli strumenti che già usi.",
    updateLabel: "È disponibile un nuovo Second Brain ({version})",
    updateDesc:
      "Aggiorna per le ultime novità. Memorie, password e strumenti collegati restano.",
    updateButton: "Aggiorna il Second Brain",
    allSetTitle: "Tutto pronto",
    allSetLede: "Due link da conservare. Li trovi sempre qui in Dettagli connessione.",
    openDashboard: "Apri il mio Second Brain",
  },
  integrations: {
    extensionTitle: "Estensione browser",
    extensionSub: "Salva pagine e evidenziazioni. Inserisci indirizzo e password nella configurazione.",
    getExtension: "Ottieni l'estensione",
    obsidianTitle: "Sincronizzazione Obsidian",
    obsidianSub: "Allinea il vault Obsidian con il Second Brain.",
    openObsidian: "Apri in Obsidian",
    getPlugin: "Ottieni il plugin",
    notionTitle: "Notion",
    notionSub: "Sincronizza le pagine Notion nella memoria.",
    notionConnected: "Collegato.",
    notionConnectedTo: "Collegato a {workspace}.",
    syncNow: "Sincronizza ora",
    syncing: "Sincronizzazione…",
    manage: "Gestisci",
    setupNotion: "Configura Notion",
  },
  logout: {
    button: "Esci da questo computer",
    confirm: "Sì, esci",
    keep: "Resta connesso",
    desc:
      "Il Second Brain e tutte le memorie restano al sicuro — questo rimuove solo " +
      "la connessione su questo computer. Puoi ricollegarti con indirizzo e password.",
  },
  workerUpdate: {
    title: "Aggiorna il Second Brain",
    ledeWithVersion:
      "È disponibile una nuova versione ({version}). " +
      "Memorie, password e strumenti collegati restano — nulla viene resettato.",
    ledeGeneric:
      "È disponibile una nuova versione del Second Brain. " +
      "Memorie, password e strumenti collegati restano — nulla viene resettato.",
    notice: "Accederai a Cloudflare una volta per autorizzare l'aggiornamento. Circa un minuto.",
    signInUpdate: "Accedi e aggiorna",
    waitingLede:
      "Completa l'accesso a Cloudflare nel browser aperto, poi torna qui.",
    updatingTitle: "Aggiornamento del Second Brain",
    updatingLede: "Di solito ci vuole un minuto. Le tue memorie sono al sicuro.",
    stepMemory: "Aggiornamento deposito memorie",
    stepRecall: "Aggiornamento richiamo intelligente",
    stepFinish: "Completamento",
    doneTitle: "Second Brain aggiornato",
    doneLede:
      "Tutto è all'ultima versione — memorie, password e strumenti collegati non sono cambiati.",
  },
  email: {
    subject: "Dettagli del tuo Second Brain",
    bodyAddress: "Indirizzo Second Brain (dashboard privata):",
    bodyMcp: "Link di connessione (incolla negli strumenti AI con connettori):",
  },
};
