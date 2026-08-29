import type { Messages } from "./types";

export const it: Messages = {
  common: {
    continue: "Continua",
    back: "Indietro",
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
    appTitle: "Second Brain",
  },
  settings: {
    title: "Impostazioni",
    language: "Lingua",
    languageDesc: "Scegli come visualizzare l'app Second Brain su questo computer.",
    english: "English",
    italian: "Italiano",
  },
  settingsPanel: {
    title: "Impostazioni avanzate",
    lede: "Come il tuo Second Brain ricorda e recupera. Le modifiche valgono dalla prossima ricerca.",
    sectionRecall: "Recupero",
    sectionRemember: "Ricorda",
    sectionAi: "AI",
    sectionMatching: "Corrispondenze",
    custom: "Personalizzato",
    customNote: "Questi valori sono stati impostati fuori dall'app e non corrispondono a nessun livello. Scegliendo un livello qui sotto verranno sostituiti.",
    reset: "Ripristina il valore predefinito",
    save: "Salva le modifiche",
    cancel: "Annulla",
    unsaved: "{count} modifiche non salvate",
    unsavedOne: "1 modifica non salvata",
    saving: "Salvataggio…",
    saved: "Salvato",
    loadFailed: "Non è stato possibile caricare le impostazioni.",
    recency: {
      label: "Quanto i ricordi recenti contano più di quelli vecchi",
      desc: "I ricordi più vecchi perdono gradualmente terreno rispetto ai nuovi. Qui decidi con quanta rapidità — e quanta protezione ottengono i ricordi consolidati e importanti.",
      levels: {
        timeless: {
          name: "Senza tempo",
          notice: "L'età conta appena. Utile se il tuo Second Brain è soprattutto materiale di riferimento che vuoi ritrovare a prescindere da quando l'hai salvato.",
        },
        balanced: {
          name: "Bilanciato",
          notice: "Il valore predefinito. A parità vince il più recente, ma una buona corrispondenza vecchia batte comunque una debole recente.",
        },
        recent_first: {
          name: "Priorità ai recenti",
          notice: "I ricordi nuovi dominano. Utile per lavoro che cambia in fretta, al prezzo di seppellire il contesto più vecchio.",
        },
      },
    },
    variety: {
      label: "Varietà nei risultati",
      desc: "Quando più ricordi dicono quasi la stessa cosa, Second Brain può restituirli tutti oppure distribuire i risultati.",
      levels: {
        focused: { name: "Mirato", notice: "Le corrispondenze più vicine, anche se alcune si ripetono." },
        balanced: { name: "Bilanciato", notice: "Il valore predefinito." },
        varied: {
          name: "Vario",
          notice: "Una scelta più ampia di ricordi diversi. Alcune corrispondenze molto simili vengono escluse per fare spazio.",
        },
      },
    },
    connections: {
      label: "Quanto seguire i collegamenti",
      desc: "Oltre alle corrispondenze dirette, Second Brain può percorrere i collegamenti tra i ricordi e portare anche ciò a cui sono connessi.",
      levels: {
        off: { name: "Disattivato", notice: "Solo corrispondenze dirette." },
        nearby: { name: "Vicini", notice: "Un passo più in là. Fa emergere contesto ovvio che non avevi cercato." },
        extended: {
          name: "Estesi",
          notice: "Due passi più in là. Contesto più ricco e, di tanto in tanto, qualcosa di forzato.",
        },
      },
    },
    detail: {
      label: "Quanto dettaglio viene restituito",
      desc: "Definisce quanta parte di ogni ricordo viene inviata al tuo assistente.",
      levels: {
        compact: {
          name: "Compatto",
          notice: "Estratti brevi. Lascia più spazio nella finestra di contesto del tuo assistente.",
        },
        standard: {
          name: "Standard",
          notice: "Il valore predefinito. Testo completo per le prime corrispondenze, estratti per le altre.",
        },
        full: {
          name: "Completo",
          notice: "Più contenuto per ogni ricordo. Risposte migliori, con un consumo di contesto molto più alto.",
        },
      },
    },
    duplicates: {
      label: "Blocco dei salvataggi quasi duplicati",
      desc: "Quando qualcosa di molto simile è già salvato, Second Brain può bloccare il salvataggio o lasciarlo passare segnalandolo.",
      note: "Vale per i nuovi salvataggi. I duplicati già presenti nel tuo Second Brain non vengono toccati.",
      levels: {
        permissive: { name: "Permissivo", notice: "Si salva quasi tutto. Le ripetizioni si accumulano." },
        standard: {
          name: "Standard",
          notice: "Il valore predefinito. I salvataggi quasi identici vengono bloccati, quelli simili segnalati.",
        },
        strict: {
          name: "Rigoroso",
          notice: "Blocca in modo aggressivo. A volte rifiuta un aggiornamento legittimo a qualcosa che avevi già salvato.",
        },
      },
    },
    compression: {
      label: "Compressione dei ricordi vecchi",
      desc: "Ogni notte, i ricordi vecchi che recuperi raramente possono essere riassunti perché la ricerca resti efficace.",
      note: "Ha effetto dall'esecuzione di questa notte. I ricordi già compressi restano compressi.",
      levels: {
        conservative: {
          name: "Conservativo",
          notice: "Protegge di più. Il tuo Second Brain cresce e le ricerche diventano via via più lente.",
        },
        standard: {
          name: "Standard",
          notice: "Il valore predefinito. I ricordi importanti o recuperati spesso non vengono mai compressi.",
        },
        aggressive: {
          name: "Aggressivo",
          notice: "Comprime prima. Cervello più snello, ma i dettagli dei ricordi vecchi vengono riassunti via.",
        },
      },
    },
    model: {
      label: "Quale modello AI usare",
      desc: "Usato per ordinare, riassumere e individuare contraddizioni nei tuoi ricordi — non per la ricerca in sé, e non per gli insight che Second Brain trae dal confronto tra i ricordi, che hanno un modello proprio qui sotto. Ogni modello elencato qui gira sul tuo account Cloudflare.",
      sizeNote: "I modelli più grandi scrivono riassunti migliori e costano più Neurons. Quelli più piccoli sono più rapidi ed economici.",
      neuronsNote: "I Neurons sono l'unità di consumo AI di Cloudflare. Il tuo piano include un'assegnazione giornaliera.",
    },
    insightModel: {
      label: "Quale modello AI usare per gli insight",
      desc: "Usato solo quando Second Brain confronta due ricordi e scrive un insight su come si collegano. Tutto il resto — ordinare, riassumere, individuare contraddizioni — usa il modello qui sopra.",
      sizeNote: "I modelli più grandi trovano insight più acuti e costano più Neurons. Quelli più piccoli sono più rapidi ed economici.",
      defaultNote: "Confrontare due ricordi è un giudizio più difficile che riassumerne uno solo, perciò qui il valore predefinito è un modello più grande di quello sopra — e poiché il confronto in sé è breve, costa comunque quasi lo stesso.",
    },
    migration: {
      lede: "Come il tuo Second Brain legge i tuoi ricordi e li abbina a ciò che chiedi.",
      label: "Come vengono letti i tuoi ricordi",
      desc:
        "Ogni ricordo viene letto una volta quando lo salvi, e le ricerche vengono " +
        "confrontate con quella lettura. Una lettura diversa può trovare corrispondenze " +
        "più precise, ma prima tutto ciò che hai già salvato va riletto.",
      entries: "{entries} ricordi salvati, tutti da rileggere.",
      entriesOne: "1 ricordo salvato, da rileggere.",
      entriesNone: "Non hai ancora salvato ricordi, quindi non c'è nulla da rileggere.",
      pickLabel: "Modo di leggere",
      inUse: "{name} (in uso ora)",
      storageWarning:
        "È più di quanto un account Cloudflare gratuito possa contenere per un " +
        "Second Brain della tua dimensione. Durante la ricostruzione vengono " +
        "conservati sia i vecchi sia i nuovi dati di ricerca, così puoi ancora " +
        "cambiare idea — ed è lì che lo spazio finirebbe. Il salvataggio di nuovi " +
        "ricordi inizierebbe a fallire. Un'opzione meno dettagliata, o un piano " +
        "Cloudflare a pagamento, lo evita.",
      pickNote:
        "Leggere in modo più dettagliato trova corrispondenze più precise e consuma una " +
        "parte maggiore della tua assegnazione AI giornaliera. Girano tutte sul tuo " +
        "account Cloudflare.",
      levels: {
        standard: {
          name: "Standard",
          notice:
            "È la più leggera per la tua assegnazione AI giornaliera e la più rapida da " +
            "ricostruire. Va bene per la maggior parte delle ricerche.",
        },
        finer: {
          name: "Più dettagliato",
          notice:
            "Coglie meglio di cosa parla ogni ricordo, così le corrispondenze meno ovvie " +
            "risalgono nei risultati. Consuma una parte maggiore della tua assegnazione " +
            "AI giornaliera.",
        },
        finest: {
          name: "Massimo dettaglio",
          notice:
            "La corrispondenza più precisa, e la più esigente sia per la tua assegnazione " +
            "AI giornaliera sia per lo spazio.",
        },
      },
      sameAsCurrent: "È già quella in uso — non c'è nulla da fare.",
      dirtyNote: "Salva o annulla prima le altre modifiche.",
      startButton: "Ricostruisci con questa opzione",
      confirmTitle: "Prima di iniziare",
      confirmLead: "Finché non finisce, la ricerca è incompleta.",
      confirmBody:
        "I tuoi ricordi sono al sicuro: viene ricostruito solo ciò che il tuo Second Brain " +
        "usa per cercare.",
      point1: "I ricordi non ancora riletti non compaiono tra i risultati.",
      point2:
        "Consuma la tua assegnazione AI giornaliera e, se finisce, si mette in pausa per oggi.",
      point3: "{chunks} parti da rileggere: circa {rounds} giri, uno dopo l'altro.",
      point4:
        "Fino alla fine non viene cancellato nulla: i vecchi dati di ricerca restano finché " +
        "non scegli tu di liberarli.",
      targetLine: "Nuovo modo di leggere: {name}",
      modelLine: "Modello: {name}",
      confirmButton: "Sì, ricostruisci",
      cancelButton: "Non ora",
      startingTitle: "Preparazione",
      startingBody:
        "Il nuovo modo di leggere i tuoi ricordi è quasi pronto; subito dopo il tuo Second " +
        "Brain inizierà a usarlo. Ci vuole un minuto o due — lascia aperta questa finestra.",
      runningTitle: "Rilettura dei tuoi ricordi",
      runningBody:
        "Finché non finisce, la ricerca è incompleta. Lascia aperta questa finestra, " +
        "oppure metti in pausa e torna più tardi: in ogni caso nulla di già riletto va " +
        "perso. Il totale può salire se salvi qualcosa di nuovo durante la rilettura.",
      pauseButton: "Metti in pausa",
      pausing: "Pausa alla fine di questo giro…",
      pausedTitle: "In pausa",
      pausedBody:
        "Tutto ciò che è stato riletto è salvato. La ricerca resta incompleta finché non " +
        "continui, e continuare non costa nulla per la parte già completata.",
      progress: "{done} su {total} ricordi riletti",
      progressPending: "Rilettura in corso…",
      skipped:
        "Ricordi che non è stato possibile rileggere finora: {failed}. Vengono ritentati " +
        "mentre la rilettura continua.",
      stalledTitle: "In pausa per oggi",
      stalledBody:
        "L'assegnazione AI di oggi è esaurita. Tutto ciò che è stato fatto è salvato e " +
        "riprendere non costa nulla per la parte già completata. Torna domani, o quando la " +
        "tua assegnazione si rinnova.",
      stalledFailingTitle: "Un ricordo sta bloccando la ricostruzione",
      stalledFailingBody:
        "Lo stesso ricordo continua a non riuscire, così l'ultimo giro non ha concluso " +
        "nulla. Aspettare non cambia niente: il tentativo successivo rifarebbe esattamente " +
        "lo stesso giro. Riprova, nel caso fosse un intoppo momentaneo, oppure ricomincia " +
        "da capo per dimenticare il punto raggiunto e rileggere tutto dall'inizio.",
      resumeButton: "Continua",
      startOverButton: "Ricomincia da capo",
      startOverNote:
        "Ricominciare da capo rilegge tutti i ricordi, anche quelli già fatti, e consuma " +
        "una seconda volta la tua assegnazione AI per quel lavoro.",
      resettingTitle: "Riavvio della rilettura",
      resettingBody:
        "Il registro di ciò che è già stato riletto viene azzerato, poi la rilettura " +
        "riparte dal tuo primo ricordo.",
      interruptedTitle: "Una ricostruzione è rimasta a metà",
      interruptedBody:
        "Una ricostruzione si è fermata a metà: {done} su {total} completati. La ricerca " +
        "resta incompleta finché non finisce, e continuare non costa nulla per la parte " +
        "già completata.",
      failedTitle: "La ricostruzione si è fermata",
      failedBody:
        "I tuoi ricordi non sono stati toccati e tutto ciò che è stato riletto è salvato. " +
        "Se riprendi, non si ricomincia da zero.",
      stuckTitle: "La ricostruzione ha smesso di avanzare",
      stuck:
        "Niente è andato perso e tutto ciò che è stato riletto è salvato. Riprovare tra " +
        "qualche minuto spesso basta; se non basta, ricomincia da capo.",
      doneTitle: "Tutti i tuoi ricordi sono stati riletti.",
      doneBody:
        "La ricerca è di nuovo completa e il tuo Second Brain abbina i ricordi nel modo nuovo.",
      changeAgain: "Cambia di nuovo",
      freeLabel: "Libera i vecchi dati di ricerca",
      freeDesc:
        "I dati di ricerca precedenti alla ricostruzione occupano ancora spazio. I tuoi " +
        "ricordi non vengono toccati: viene rimosso solo ciò che resta dei vecchi dati di " +
        "ricerca, che il tuo Second Brain non usa più. È il solo passaggio qui che non si " +
        "può annullare.",
      freeButton: "Libera i vecchi dati",
      freeConfirm: "Sì, liberali — so che non si può annullare",
      freeKeep: "Conservali per ora",
      freeing: "Liberazione dei vecchi dati di ricerca",
      freeingBody: "Ci vuole solo un momento.",
      freedTitle: "Tutto fatto",
      freedBody:
        "Il tuo Second Brain legge e abbina i tuoi ricordi nel modo nuovo, e i vecchi dati " +
        "di ricerca non ci sono più. Nient'altro è cambiato.",
      loading: "Verifica di come vengono letti i tuoi ricordi…",
      loadFailed:
        "Non è stato possibile verificare come vengono letti i tuoi ricordi in questo momento.",
      barRunning:
        "Rilettura dei tuoi ricordi — {done} su {total} completati. Le altre impostazioni " +
        "sono bloccate fino alla fine.",
      barWorking:
        "Il tuo Second Brain è al lavoro. Le altre impostazioni sono bloccate fino alla fine.",
    },
  },
  welcome: {
    title: "Configura il tuo Second Brain",
    lede:
      "Una memoria privata condivisa tra tutti gli strumenti AI che usi. " +
      "Ogni app e dispositivo che colleghi è una porta sulla stessa memoria, " +
      "quindi non c'è nulla da sincronizzare tra loro. " +
      "Ci vogliono circa due minuti, tutto nel tuo spazio privato, " +
      "senza competenze tecniche.",
    getStarted: "Inizia",
    alreadyHave: "Hai già un Second Brain?",
    footnote: "Gratuito · I tuoi dati restano tuoi",
  },
  audience: {
    title: "Per chi è questo Second Brain?",
    lede:
      "Entrambe le scelte creano lo stesso Second Brain privato, nel tuo spazio " +
      "Cloudflare. Cambia solo ciò che ti spieghiamo alla fine.",
    justMe: "Solo per me",
    aTeam: "Con il mio team",
    existingTitle: "Altri useranno questo Second Brain?",
    existingLede:
      "Il tuo Second Brain ora supporta i team: ogni membro ha ricordi privati, " +
      "più un livello condiviso visibile a tutti. Sei l'amministratore — invita i " +
      "membri dalla scheda Team della dashboard quando vuoi.",
    existingFootnote:
      "Scelta una sola volta: quando entrano i membri, il brain resta un brain di " +
      "team. I tuoi ricordi non vengono mai coinvolti.",
    footnote:
      "In un Second Brain di team ogni persona riceve un accesso proprio — e " +
      "condividere un ricordo è sempre una scelta di chi l'ha scritto.",
  },
  connectExisting: {
    title: "Collega il tuo Second Brain",
    lede:
      "Nuovo computer? Inserisci l'indirizzo del Second Brain che hai già e poi " +
      "la tua password — oppure, se qualcuno ti ha invitato nel suo team, il " +
      "token che ti ha mandato. Nulla verrà modificato o resettato.",
    addressPlaceholder: "Indirizzo Second Brain (…workers.dev)",
    passwordPlaceholder: "La tua password o il token di invito del team",
    connect: "Collega",
    footnote:
      "L'indirizzo è in Dettagli connessione sull'altro computer " +
      "o nell'email di conferma che hai inviato a te stesso.",
    chooseLede:
      "Nuovo computer? Collega il Second Brain che hai già — nulla verrà " +
      "modificato o resettato.",
    signInButton: "Accedi con Cloudflare",
    signInHint: "Troveremo noi il tuo Second Brain — nessun indirizzo da cercare.",
    signInFootnote:
      "Il tuo Second Brain si trova nel tuo spazio su Cloudflare, quindi " +
      "accediamo lì per trovarlo. Cloudflare ti chiederà di autorizzare " +
      "l'accesso. Non vediamo mai la tua password Cloudflare e non conserviamo " +
      "la chiave: accedi di nuovo ogni volta. Preferisci di no? " +
      "\u201cInserisci l'indirizzo a mano\u201d non richiede l'accesso a Cloudflare.",
    manualButton: "Inserisci l'indirizzo a mano",
    accountPickerTitle: "In quale spazio cerchiamo?",
    accountPickerLede: "Il tuo login ne ha più di uno — scegli dove si trova il tuo Second Brain.",
    searchingTitle: "Ricerca del tuo Second Brain",
    searchingLede: "Controlliamo il tuo spazio Cloudflare. Può richiedere fino a un minuto.",
    searchingStep: "Analisi del tuo spazio",
    pickTitleOne: "È questo il tuo Second Brain?",
    pickTitleMany: "Quale è il tuo Second Brain?",
    pickLedeOne: "Collegati, oppure inserisci a mano un altro indirizzo.",
    pickLedeMany: "Scegli quello a cui vuoi collegarti.",
    noneFound:
      "Non abbiamo trovato un Second Brain in quello spazio. Se si trova " +
      "altrove — un altro spazio o un tuo indirizzo web — inserisci l'indirizzo qui sotto.",
    unlockTitle: "Inserisci la tua password",
    unlockLede:
      "È la password che hai scelto quando hai configurato il tuo Second Brain " +
      "la prima volta — oppure, se qualcuno ti ha invitato nel suo team, il " +
      "token che ti ha mandato. Nulla verrà modificato o resettato.",
    lostPassword: "Non ho la mia password",
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
  changePassword: {
    title: "Cambia la tua password",
    lede:
      "Ne scegli una nuova, la salvi, e sostituisce la vecchia ovunque. " +
      "I tuoi ricordi, il tuo indirizzo e gli strumenti AI collegati restano.",
    notice:
      "La vecchia password smette di funzionare appena questa operazione " +
      "finisce. Gli altri tuoi computer chiederanno quella nuova alla prossima " +
      "apertura.",
    signInButton: "Accedi e continua",
    signInFootnote:
      "Il tuo Second Brain si trova nel tuo spazio su Cloudflare, quindi " +
      "accediamo lì per cambiarla. Non vediamo mai la tua password Cloudflare.",
    waitingLede:
      "Completa l'accesso a Cloudflare nel browser aperto, poi torna qui.",
    blockedTitle: "La password non può essere cambiata adesso",
    blockedBody:
      "Il tuo Second Brain sta ricostruendo il modo in cui legge i tuoi ricordi. " +
      "Cambiare la password nel mezzo può fermare la ricostruzione a metà e far " +
      "sembrare un problema di password una ricostruzione fallita, quindi si " +
      "aspetta che finisca.",
    blockedEscape:
      "Se non c'è nessuna ricostruzione in corso, significa che ne è rimasta una " +
      "a metà. Apri le Impostazioni avanzate e continuala: il blocco sparisce " +
      "quando la ricostruzione finisce. Anche ricominciarla da capo ci arriva, " +
      "ma rilegge tutti i ricordi dal primo, quindi ci vuole più tempo.",
    blockedButton: "Apri le Impostazioni avanzate",
    // "non è mai arrivata conferma" riprende alla lettera failUnsureBody: è lo
    // stesso fatto, e due formulazioni diverse leggerebbero come due situazioni
    // diverse.
    blockedMayBeLive:
      "Un tentativo precedente è stato inviato al tuo Second Brain e non è mai " +
      "arrivata conferma, quindi la password qui sotto potrebbe già essere " +
      "quella che funziona. Salvala prima di chiudere questa finestra. " +
      "Riprovare chiarirebbe la situazione, ma è possibile solo quando la " +
      "ricostruzione è finita.",
    lostTitle: "I tuoi ricordi sono al sicuro",
    lostLede:
      "Non hai perso nulla. Nessuno può recuperare la tua password al posto tuo " +
      "— né questa app né Cloudflare — ma può essere sostituita, ed è così che " +
      "rientri.",
    lostBodySignedIn:
      "Hai già effettuato l'accesso allo spazio Cloudflare in cui si trova il tuo " +
      "Second Brain, ed è quello a decidere chi può entrare. Puoi quindi " +
      "impostare subito una nuova password. Tutto ciò che hai salvato resta " +
      "esattamente dov'è.",
    lostBodySignIn:
      "Il tuo Second Brain si trova nel tuo spazio su Cloudflare, ed è quello a " +
      "decidere chi può entrare. Accedi lì e potrai impostare una nuova password. " +
      "Tutto ciò che hai salvato resta esattamente dov'è.",
    lostNotice:
      "Tutto ciò che ha già la vecchia password chiederà quella nuova: gli altri " +
      "tuoi computer, l'estensione del browser, il plugin di Obsidian.",
    lostContinueButton: "Scegli una nuova password",
    lostSignInButton: "Accedi con Cloudflare",
    pickBrainLedeOne:
      "Imposta una nuova password su questo, oppure torna indietro e scegline un altro.",
    pickBrainLedeMany: "Scegli quello di cui hai perso la password.",
    addressTitle: "Qual è l'indirizzo del tuo Second Brain?",
    addressLede:
      "Non l'abbiamo trovato in quello spazio. Inserisci l'indirizzo e " +
      "imposteremo una nuova password: non serve quella attuale.",
    addressLedeManual:
      "Inserisci l'indirizzo del Second Brain a cui vuoi dare una nuova " +
      "password: non serve quella attuale.",
    pickTitle: "Scegli una nuova password",
    pickLede:
      "Questa sostituisce la vecchia. Cloudflare non potrà più mostrartela, e " +
      "nemmeno noi: conservane una copia tua.",
    generatedNote:
      "Ne abbiamo generata una robusta per te. Scrivici sopra se preferisci " +
      "sceglierne una tua.",
    pickNotice:
      "La vecchia password smette di funzionare nel momento in cui questa entra in vigore.",
    saveTitle: "Salvala da qualche parte",
    saveLede:
      "Una volta impostata, niente in questa app né su Cloudflare te la mostrerà " +
      "di nuovo. Resta visibile in questa finestra finché non la chiudi; dopo, " +
      "ti servirà la copia che hai conservato.",
    passwordLabel: "La tua nuova password",
    saveAdvice:
      "Un gestore password è il posto giusto. Se la tieni altrove, tienila dove " +
      "terresti la chiave di tutto ciò che hai scritto.",
    saveConfirm: "L'ho salvata — cambia la password",
    saveBack: "Scegline un'altra",
    progressTitle: "Cambio della password",
    progressLede: "Ci vogliono fino a un paio di minuti. Lascia aperta questa finestra.",
    stepSend: "Impostazione della nuova password",
    stepConfirm: "Attesa che il tuo Second Brain la accetti",
    stepLocal: "Salvataggio su questo computer",
    doneTitle: "La tua password è stata cambiata",
    doneTitleLost: "Sei di nuovo dentro",
    doneLede:
      "Questo computer sta già usando la nuova password. I tuoi ricordi, il tuo " +
      "indirizzo e tutto ciò che hai collegato non sono cambiati.",
    doneNeedsHead: "Che cosa chiederà la nuova password",
    doneNeeds1: "Gli altri tuoi computer, la prossima volta che ci apri Second Brain.",
    doneNeeds2:
      "L'estensione del browser e il plugin di Obsidian, su questo computer come " +
      "su qualsiasi altro. Ognuno conserva la propria copia e questa modifica " +
      "non li raggiunge.",
    doneNeeds3: "Il comando brain nel terminale di qualsiasi altro computer.",
    doneNeeds4: "Le schede del browser in cui hai aperto la dashboard direttamente.",
    doneKeptHead: "Che cosa resta collegato",
    doneKept:
      "Gli strumenti AI che hai collegato accedendo tramite il tuo link di " +
      "connessione restano collegati e continuano a funzionare. Al momento del " +
      "collegamento ognuno ha ricevuto un accesso proprio, separato dalla tua " +
      "password, quindi cambiarla non li tocca. Ciò che invece hai collegato " +
      "incollando la password si trova nell'elenco qui sopra: chiederà quella " +
      "nuova.",
    // "averla vista" softened EN's "may have had it": vedere una password legge
    // come un'occhiata alle spalle, averla è ciò che la rende pericolosa — e
    // questa è l'unica riga rivolta a chi ha subito una fuga di dati.
    doneLeak:
      "Se hai cambiato la password perché qualcun altro potrebbe averla avuta, " +
      "quelle connessioni sono l'unica cosa che questa operazione non ha chiuso. " +
      "Scollegarle fa sì che ogni strumento chieda di essere collegato di nuovo.",
    doneDisconnectButton: "Scollega gli strumenti AI…",
    doneShow: "Mostra la mia nuova password",
    doneHide: "Nascondila",
    failNotSentTitle: "Non è cambiato nulla",
    failNotSentBody:
      "La nuova password non è mai arrivata al tuo Second Brain, quindi la " +
      "vecchia funziona ancora e tutto è rimasto com'era. Riprovare è sicuro.",
    failNotSentLabel: "La password che hai scelto — non in uso",
    failDetail: "Cosa è andato storto: {detail}",
    failUnsureTitle: "La tua nuova password potrebbe essere già attiva",
    failUnsureBody:
      "La modifica è stata inviata al tuo Second Brain, ma non è arrivata " +
      "conferma in tempo, quindi non possiamo dirti quale password sia in uso. " +
      "Salva quella qui sotto prima di fare qualsiasi altra cosa: potrebbe essere " +
      "quella che funziona adesso.",
    failUnsureRetry:
      "Riprova. Impostare la stessa password una seconda volta non cambia nulla " +
      "se era già passata, e completa l'operazione se non lo era: in entrambi i " +
      "casi saprai come stanno le cose.",
    failUnsureFootnote:
      "Questo computer non è ancora stato aggiornato, quindi potrebbe chiederti " +
      "una password. Se succede, usa quella qui sopra.",
    failUnsureLeave: "Lascia perdere per ora",
    recheckButton: "Controlla di nuovo",
    recheckConfirmed:
      "Il tuo Second Brain risponde alla nuova password, quindi quella parte è " +
      "fatta. Questo computer non l'ha ancora salvata: riprova per completare " +
      "l'operazione, e sul tuo Second Brain non cambierà nulla.",
    recheckUnconfirmed:
      "Il tuo Second Brain non risponde ancora alla nuova password. Forse serve " +
      "ancora un momento, oppure la modifica non è arrivata: riprovare chiarisce " +
      "la situazione in entrambi i casi.",
    recheckUnreachable:
      "Non siamo riusciti a raggiungere il tuo Second Brain per chiederglielo, " +
      "quindi questo non chiarisce nulla in un senso o nell'altro: la modifica " +
      "potrebbe essere comunque passata. Controlla di nuovo tra un momento, " +
      "oppure passa direttamente a riprovare il cambio.",
    failLocalTitle: "La password è stata cambiata, ma non salvata su questo computer",
    failLocalTitlePartial:
      "La password è stata cambiata, ma su questo computer qualcosa ha ancora la vecchia",
    failLocalBody:
      "Il tuo Second Brain sta usando la nuova password. Questo computer non è " +
      "riuscito a memorizzarla, quindi non potrà aprire il tuo Second Brain " +
      "finché non ti ricolleghi con quella nuova: salvala ora, se non l'hai già " +
      "fatto.",
    failLocalCli:
      "Il comando brain nel terminale usa ancora la vecchia password. Esegui " +
      "brain setup per puntarlo a quella nuova.",
    failLocalDashboard:
      "La finestra di Second Brain già aperta usa ancora la vecchia password. " +
      "Chiudila e riaprila.",
    failLocalReconnect: "Ricollega questo computer",
    leaveWarn:
      "Questa è l'ultima schermata che mostra questa password. Se non l'hai " +
      "ancora messa al sicuro, fallo adesso.",
    leaveConfirm: "L'ho salvata — esci",
    leaveKeep: "Resta qui",
  },
  passwordChangedElsewhere: {
    title: "La tua password è stata cambiata su un altro computer",
    lede:
      "Il tuo Second Brain ha una nuova password, quindi quella salvata su questo " +
      "computer non lo apre più. Non è andato perso nulla e non è stato " +
      "cancellato nulla: a questo computer serve solo quella nuova.",
    body:
      "La trovi dove l'hai salvata quando l'hai cambiata. È lo stesso Second " +
      "Brain, allo stesso indirizzo.",
    findAgain: "Ritrova il mio Second Brain",
    findAgainHint:
      "Accede a Cloudflare e lo cerca, nel caso tu stia collegando un Second " +
      "Brain diverso.",
    // "non sei stato tu" era l'unico partecipio al maschile singolare rivolto
    // all'utente in tutto il catalogo: ovunque altrove l'accordo è con un
    // oggetto, mai con chi legge.
    footnote:
      "Non hai quella nuova — o non l'hai cambiata tu? Scegliendo una nuova " +
      "password, la vecchia viene chiusa definitivamente.",
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
    title: "Connessioni",
    lede:
      "Da qui colleghi le cose al tuo Second Brain. " +
      "Le memorie vivono nella dashboard, che si apre in una finestra dedicata.",
    notSetupTitle: "Non ancora configurato",
    notSetupLede: "Completa prima la configurazione — i dettagli appariranno qui.",
    addressLabel: "Indirizzo del Second Brain",
    addressDesc: "La dashboard web privata e dove collegi nuovi strumenti. Salvalo.",
    mcpLabel: "Link di connessione (per strumenti AI)",
    mcpDesc: "Incollalo in qualsiasi strumento AI che supporta i connettori.",
    passwordLabel: "La tua password",
    passwordDesc:
      "È la chiave del tuo Second Brain. Qui non viene mostrata, ma questo " +
      "computer ne conserva una copia: nel suo archivio sicuro e, se hai " +
      "configurato il comando brain, nel file di impostazioni di quel comando. " +
      "Cloudflare invece non può rileggerla in alcun modo. Se ne vuoi una " +
      "diversa, puoi impostarla ora.",
    passwordButton: "Cambia la password",
    disconnectLabel: "Scollega i tuoi strumenti AI",
    disconnectDesc:
      "Gli strumenti AI che hanno effettuato l'accesso tramite il tuo link di " +
      "connessione hanno ricevuto ognuno un accesso proprio, separato dalla tua " +
      "password. Questa azione li chiude tutti insieme. Ciò che invece hai " +
      "collegato incollando la password non viene toccato: quelle connessioni si " +
      "chiudono cambiando la password. I tuoi ricordi e la tua password restano " +
      "come sono.",
    disconnectButton: "Scollega gli strumenti AI…",
    disconnectConfirmDesc:
      "Ogni strumento AI che ha effettuato l'accesso tramite il tuo link di " +
      "connessione — su questo computer e su qualsiasi altro — andrà collegato " +
      "di nuovo, e ognuno ti chiederà la password quando lo farai.",
    disconnectConfirm: "Sì, scollegali tutti",
    disconnectKeep: "Lasciali collegati",
    disconnectWorking: "Scollegamento…",
    // Non "Scollegati.": in apertura di frase si legge prima come imperativo
    // riflessivo — "scollegati tu" — invece che come participio.
    disconnectDone:
      "Connessioni chiuse. Ogni strumento chiederà di essere collegato di nuovo " +
      "la prossima volta che lo usi.",
    disconnectDoneNone:
      "Nessuno strumento aveva effettuato l'accesso tramite il tuo link di " +
      "connessione, quindi qui non c'era nulla da chiudere. Gli strumenti che " +
      "usano la tua password non sono interessati: quelle connessioni si " +
      "chiudono cambiando la password.",
    disconnectFailed:
      "Non è stato possibile chiudere alcune connessioni. Quelle già chiuse " +
      "restano chiuse, quindi riprovando si riprende solo da ciò che manca.",
    connectToolsTitle: "Collega i tuoi strumenti AI",
    connectToolsDesc:
      "Gli strumenti su questo computer si collegano con un clic. Per gli altri, " +
      "incolla il link di connessione nelle impostazioni del connettore — " +
      "chiederà la password la prima volta.",
    integrationsTitle: "Integrazioni",
    integrationsDesc: "Importa note e pagine dagli strumenti che già usi.",
    navConnection: "Connessione",
    navTools: "Strumenti AI",
    navIntegrations: "Integrazioni",
    navComputer: "Questo computer",
    updateLabel: "È disponibile un nuovo Second Brain ({version})",
    updateDesc:
      "Aggiorna per le ultime novità. Memorie, password e strumenti collegati restano.",
    updateDescOther:
      "Chi ha creato questo brain deve aggiornarlo: l'aggiornamento avviene nel " +
      "suo account Cloudflare, quindi non è un'operazione che questo computer " +
      "può fare. Nel frattempo nulla di ciò che hai salvato viene toccato.",
    updateDescLegacy:
      "Questo brain usa una versione più vecchia, che non sa ancora dire a " +
      "questa app chi sei: per questo l'aggiornamento viene proposto a " +
      "chiunque apra questa finestra. Viene eseguito solo nell'account " +
      "Cloudflare in cui il brain è stato creato — se non è il tuo, si ferma e " +
      "te lo dice. Basta un aggiornamento perché il brain sappia rispondere, e " +
      "questa nota sparisce.",
    updateButton: "Aggiorna il Second Brain",
    allSetTitle: "Tutto pronto",
    allSetLede: "Due link da conservare. Li trovi sempre qui in Dettagli connessione.",
    allSetTeamLede:
      "Due link da conservare — e un team da invitare. Li trovi sempre qui in Dettagli connessione.",
    teamCardLabel: "Il Second Brain del tuo team",
    teamCardBody:
      "Hai effettuato l'accesso come proprietario-amministratore di questo brain. " +
      "Apri la dashboard e usa il pannello Team per invitare le persone: ogni " +
      "membro riceve il suo token. I ricordi privati di ciascuno restano privati, " +
      "e ciò che viene condiviso finisce nel livello aziendale, visibile a tutti.",
    teamCardBodyAdmin:
      "Hai effettuato l'accesso come amministratore del team. Apri la dashboard e usa il pannello Team per invitare altre persone: ognuna riceve il proprio token. La password di questo brain la cambia chi lo ha creato, dal proprio account Cloudflare.",
    teamCardBodyMember:
      "Hai effettuato l'accesso come membro del team. I tuoi ricordi restano " +
      "privati; ciò che condividi finisce nel livello aziendale, dove tutte le " +
      "persone possono trovarlo. Se questo token smette di funzionare, " +
      "chiedine uno nuovo a un amministratore.",
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
    connectedPlain: "Collegato.",
    connectedTo: "Collegato a {workspace}.",
    syncNow: "Sincronizza ora",
    syncing: "Sincronizzazione…",
    manage: "Gestisci",
    setUp: "Configura",
    appsTitle: "App",
    back: "Tutte le integrazioni",
    categoryKnowledge: "Conoscenza",
    categoryCalendar: "Calendari",
    categoryEmail: "Email",
    categoryOther: "Altro",
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
