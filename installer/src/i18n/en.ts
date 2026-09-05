import type { Messages } from "./types";

export const en: Messages = {
  common: {
    continue: "Continue",
    back: "Back",
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
    appTitle: "Second Brain",
    continueToCloudflare: "Continue to Cloudflare",
    continueToConnectionDetails: "Continue to connection details",
    trySetupAgain: "Try setup again",
    skipUpdateForNow: "Skip update for now",
  },
  settings: {
    title: "Settings",
    language: "Language",
    languageDesc: "Choose how the Second Brain app is displayed on this computer.",
    english: "English",
    italian: "Italiano",
  },
  settingsPanel: {
    title: "Advanced Settings",
    lede: "How your Second Brain remembers and recalls. Changes apply to your next search.",
    sectionRecall: "Recall",
    sectionRemember: "Remember",
    sectionAi: "AI",
    sectionMatching: "Matching",
    custom: "Custom",
    customNote: "These values were set outside the app and don't match a preset. Picking a level below will replace them.",
    reset: "Reset to default",
    save: "Save changes",
    cancel: "Cancel",
    unsaved: "{count} unsaved changes",
    unsavedOne: "1 unsaved change",
    saving: "Saving…",
    saved: "Saved",
    loadFailed: "We couldn't load Advanced Settings. Close this window and try again.",
    recency: {
      label: "How much recent memories outrank older ones",
      desc: "Older memories gradually lose ground to newer ones. This sets how steeply — and how much protection settled, important memories get.",
      levels: {
        timeless: {
          name: "Timeless",
          notice: "Age barely matters. Good if your brain is mostly reference you want found regardless of when you saved it.",
        },
        balanced: {
          name: "Balanced",
          notice: "The default. Recent wins ties, but a strong old match still beats a weak new one.",
        },
        recent_first: {
          name: "Recent-first",
          notice: "Newer memories dominate. Good for fast-moving work, at the cost of burying older context.",
        },
      },
    },
    variety: {
      label: "Variety in results",
      desc: "When several memories say nearly the same thing, Second Brain can return all of them or spread the results out.",
      levels: {
        focused: { name: "Focused", notice: "The closest matches, even if a few repeat each other." },
        balanced: { name: "Balanced", notice: "The default." },
        varied: {
          name: "Varied",
          notice: "A wider spread of different memories. Some very close matches get dropped to make room.",
        },
      },
    },
    connections: {
      label: "How far to follow connections",
      desc: "Past direct matches, Second Brain can walk the links between memories and pull in what they connect to.",
      levels: {
        off: { name: "Off", notice: "Direct matches only." },
        nearby: { name: "Nearby", notice: "One step out. Surfaces obvious context you didn't search for." },
        extended: {
          name: "Extended",
          notice: "Two steps out. Richer context, and occasionally something you'd call a stretch.",
        },
      },
    },
    detail: {
      label: "How much detail comes back",
      desc: "Sets how much of each memory gets sent to your assistant.",
      levels: {
        compact: {
          name: "Compact",
          notice: "Short snippets. Leaves the most room in your assistant's context window.",
        },
        standard: { name: "Standard", notice: "The default. Full text for the top matches, snippets below." },
        full: { name: "Full", notice: "More of every memory. Best answers, uses noticeably more context." },
      },
    },
    duplicates: {
      label: "Blocking near-duplicate saves",
      desc: "When something very similar is already stored, Second Brain can block the save or let it through with a flag.",
      note: "Applies to new saves. Duplicates already in your brain aren't affected.",
      levels: {
        permissive: { name: "Permissive", notice: "Almost everything saves. Repeats accumulate." },
        standard: {
          name: "Standard",
          notice: "The default. Near-identical saves are blocked, similar ones flagged.",
        },
        strict: {
          name: "Strict",
          notice: "Blocks aggressively. Occasionally rejects a genuine update to something you already stored.",
        },
      },
    },
    compression: {
      label: "Compressing old memories",
      desc: "Each night, old memories you rarely recall can be folded into summaries so search stays sharp.",
      note: "Takes effect on tonight's run. Already-compressed memories stay compressed.",
      levels: {
        conservative: {
          name: "Conservative",
          notice: "Protects more. Your brain grows larger and searches get gradually slower.",
        },
        standard: {
          name: "Standard",
          notice: "The default. Important or frequently-recalled memories are never compressed.",
        },
        aggressive: {
          name: "Aggressive",
          notice: "Compresses sooner. Leaner brain, and detail in old memories is summarized away.",
        },
      },
    },
    model: {
      label: "Which AI model to use",
      desc: "Used for sorting, summarizing, and spotting contradictions in your memories — not for the search itself, and not for the insights Second Brain draws between memories, which have their own model below. Every model here runs on your own Cloudflare account.",
      sizeNote: "Larger models write better summaries and cost more neurons. Smaller ones are faster and cheaper.",
      neuronsNote: "Neurons are Cloudflare's usage unit for AI. Your plan includes a daily allowance.",
    },
    insightModel: {
      label: "Which AI model draws insights",
      desc: "Used only when Second Brain compares two memories and writes an insight about how they connect. Everything else — sorting, summarizing, spotting contradictions — uses the model above instead.",
      sizeNote: "Larger models draw sharper insights and cost more neurons. Smaller ones are faster and cheaper.",
      defaultNote: "Comparing two memories is a harder judgment than summarizing one, so this defaults to a larger model than the one above — and since the comparison itself is short, it costs about the same.",
    },
    migration: {
      lede: "How your Second Brain reads your memories and matches them to what you ask for.",
      label: "How your memories are read",
      desc:
        "Each memory is read once when you save it, and searches are matched against that " +
        "reading. A different reader can match more precisely, but everything you have " +
        "already saved has to be read again first.",
      // Counted in memories, the same unit the progress line uses. The piece
      // count appears only where it is about the daily AI allowance, so the two
      // screens never present the same job in two different units.
      entries: "{entries} memories saved, all to be read again.",
      entriesOne: "1 memory saved, to be read again.",
      entriesNone: "No memories saved yet, so there is nothing to read again.",
      pickLabel: "How to read your memories",
      inUse: "{name} (in use now)",
      storageWarning:
        "This is more than a free Cloudflare account can hold for a brain your " +
        "size. While the rebuild runs, both the old and new search data are kept " +
        "so you can still change your mind — and that is when it would run out. " +
        "Saving new memories would start failing. A coarser option, or a paid " +
        "Cloudflare plan, avoids it.",
      pickNote:
        "Reading in more detail matches more precisely. Each option says what it costs. " +
        "All of these run on your own Cloudflare account.",
      /**
       * The picker shows these names and never the model id. This is the last
       * label read before a one-way operation, and the position of an opaque
       * string in a list is not something anyone can reason about well.
       */
      levels: {
        standard: {
          name: "Standard",
          notice:
            "The lightest of the English options on your daily AI allowance, and the " +
            "quickest to rebuild. Good enough for most searches.",
        },
        finer: {
          name: "Finer detail",
          notice:
            "Catches more of what each memory is about, so near-misses sort better. Uses " +
            "more of your daily AI allowance.",
        },
        finest: {
          name: "Finest detail",
          notice:
            "The most precise matching, and the heaviest of the English options on both " +
            "your daily AI allowance and your storage.",
        },
        multilingual: {
          name: "Multilingual",
          notice:
            "Reads memories in over 100 languages, at a detail comparable to Finest. The three " +
            "options above are tuned for English only. Lighter on your daily AI allowance than " +
            "Standard; uses the same storage as Finest.",
        },
      },
      sameAsCurrent: "That's the one in use now — nothing to do.",
      dirtyNote: "Save or cancel your other changes first.",
      startButton: "Rebuild with this",
      confirmTitle: "Before you start",
      // One full-weight sentence. The rest of this screen is a grey block, and a
      // grey block before a one-way operation does not get read.
      confirmLead: "Search will be incomplete until this finishes.",
      confirmBody:
        "Your memories are safe — only what your Second Brain uses to search gets rebuilt.",
      point1: "Memories not read again yet won't come back in results.",
      point2: "It uses your daily AI allowance, and pauses for the day if that runs out.",
      // How long, in the only unit the app can honestly promise: batches are
      // capped by pieces, and the rounds run one after another.
      point3: "{chunks} pieces to read again — about {rounds} rounds, one after another.",
      point4: "Nothing is deleted until you choose to free the old search data at the end.",
      targetLine: "Switching to: {name}",
      // Secondary, and only here: the id earns its place on the screen that
      // commits, where someone may want to check exactly what they are getting.
      modelLine: "Model: {name}",
      confirmButton: "Yes, rebuild it",
      cancelButton: "Not now",
      startingTitle: "Getting ready",
      startingBody:
        "Setting up the new way of reading your memories, then pointing your Second Brain " +
        "at it. This takes a minute or two — leave this window open.",
      runningTitle: "Reading your memories again",
      runningBody:
        "Search is incomplete until this finishes. Leave this window open, or pause and " +
        "come back — nothing already read again is lost either way. The total can go up " +
        "if you save something new while this runs.",
      pauseButton: "Pause for now",
      pausing: "Pausing after this round…",
      pausedTitle: "Paused",
      pausedBody:
        "Everything read again so far is saved. Search stays incomplete until you carry " +
        "on, and carrying on costs nothing for what's already done.",
      progress: "{done} of {total} memories read again",
      progressPending: "Working through them now…",
      // Label form on purpose: it reads correctly at any count. Worded as
      // attempts because a memory that failed stays in front of the cursor and
      // is tried again, so this is a count of tries and not a count of losses.
      skipped:
        "Memories that couldn't be read again yet: {failed}. They get another try as this " +
        "carries on.",
      stalledTitle: "Paused for today",
      stalledBody:
        "Today's AI allowance is used up. Everything done so far is saved, and picking it " +
        "up again costs nothing for what's already done. Come back tomorrow, or whenever " +
        "your allowance resets.",
      // The other stall. "Come back tomorrow" is advice that can never work here,
      // and Carry on alone would rerun the identical failing round forever.
      stalledFailingTitle: "One memory is blocking the rebuild",
      stalledFailingBody:
        "The same memory keeps failing, so the last round got nothing done. Waiting won't " +
        "change that — the next try would run the identical round. Try again in case it " +
        "was a blip, or start over to forget where it got to and read everything from the " +
        "beginning.",
      resumeButton: "Carry on",
      startOverButton: "Start over instead",
      startOverNote:
        "Starting over reads every memory again, including the ones already done, and " +
        "spends your AI allowance on that work a second time.",
      resettingTitle: "Starting over",
      resettingBody:
        "Clearing the record of what has been read again, then beginning from your first " +
        "memory.",
      interruptedTitle: "A rebuild was left unfinished",
      interruptedBody:
        "A rebuild stopped partway — {done} of {total} done. Search stays incomplete until " +
        "it finishes, and carrying on costs nothing for what's already done.",
      failedTitle: "The rebuild stopped",
      failedBody:
        "Your memories are untouched and everything read again so far is saved. Carrying " +
        "on picks up where it stopped — it won't start over.",
      // Its own screen. Stacked under the failed copy this said the same thing
      // twice, in two voices, the second in red arguing with the first.
      stuckTitle: "The rebuild stopped making progress",
      stuck:
        "Nothing is lost, and everything read again so far is saved. Trying again in a few " +
        "minutes often clears it; if it doesn't, start over.",
      doneTitle: "Your memories have all been read again",
      doneBody:
        "Search is complete again, and your Second Brain is now matching memories the new way.",
      changeAgain: "Change this again",
      freeLabel: "Free up the old search data",
      freeDesc:
        "The search data from before the rebuild is still taking up space. Your memories " +
        "aren't touched — this only removes the leftover search data your Second Brain no " +
        "longer uses. It is the one step here that can't be undone.",
      freeButton: "Free up the old data",
      freeConfirm: "Yes, free it up — I know this can't be undone",
      freeKeep: "Keep it for now",
      freeing: "Freeing up the old search data",
      freeingBody: "This only takes a moment.",
      freedTitle: "All done",
      freedBody:
        "Your Second Brain reads and matches your memories the new way, and the old search " +
        "data is gone. Nothing else changed.",
      loading: "Checking how your memories are read…",
      loadFailed: "We couldn't check your search settings right now. Try again in a moment.",
      barRunning:
        "Reading your memories again — {done} of {total} done. Other settings are locked " +
        "until it finishes.",
      barWorking: "Working on your Second Brain. Other settings are locked until this finishes.",
    },
  },
  welcome: {
    title: "Set up your Second Brain",
    lede:
      "One private memory that the AI apps you choose can use. It lives in a Cloudflare account you control. We'll guide you through creating or connecting it; most setups take a few minutes.",
    getStarted: "Create a new Second Brain",
    alreadyHave: "Connect a Second Brain I already have",
    footnote: "Free to start · Your data stays in the Cloudflare account you choose",
  },
  audience: {
    title: "Will you use this on your own or with a team?",
    lede:
      "Choose how you plan to use this new Second Brain. If you were invited to someone else's team, go back and choose 'Connect a Second Brain I already have.'",
    justMe: "Just me",
    aTeam: "Create a team brain",
    existingTitle: "Will you use this Second Brain with a team?",
    existingLede:
      "You can make this a team brain. Each person has private memories and can choose what to share with the team. If you choose a team, you can invite people later from the dashboard.",
    existingFootnote:
      "This choice becomes permanent once someone joins the team. Your existing personal memories stay private.",
    footnote:
      "On a team brain, each person has their own sign-in and private memories. People choose which memories to share with the team.",
  },
  connectExisting: {
    title: "Connect to a Second Brain",
    // The lede on `manualEntryScreen`, which is where "none found", "Enter the
    // address myself" and a pasted address all land — so it is the screen a
    // team member reaches, their brain being in the owner's Cloudflare account
    // rather than their own. It sits directly above a field that accepts either
    // credential and must name both.
    lede:
      "Paste the Second Brain web address, then enter either its password or the team sign-in token from your invitation. Connecting only saves access on this computer.",
    addressPlaceholder: "Second Brain web address (paste the link you were given)",
    passwordPlaceholder: "Password or team sign-in token",
    connect: "Connect this computer",
    footnote:
      "Find the address in Connection details on another computer, or in the invitation or confirmation email.",
    chooseLede:
      "Choose how to connect. If this is your own Second Brain, we can look for it in your Cloudflare account. If you were invited to a team, use the address and sign-in token from your invitation.",
    signInButton: "Find my Second Brain in Cloudflare",
    signInHint: "Use this only for a Second Brain in your own Cloudflare account.",
    signInFootnote:
      "For a Second Brain you set up yourself, Cloudflare lets us look up its address. Cloudflare handles the sign-in; this app never sees your Cloudflare password. If someone invited you to their team, you do not need a Cloudflare account—choose 'I have an address or team sign-in token.'",
    manualButton: "I have an address or team sign-in token",
    accountPickerTitle: "Which Cloudflare account should we search?",
    accountPickerLede: "Choose the account where you created your Second Brain.",
    searchingTitle: "Looking for your Second Brain",
    searchingLede: "Searching this Cloudflare account. This can take up to a minute.",
    searchingStep: "Looking for Second Brains in this account",
    pickTitleOne: "Is this the Second Brain you want to connect?",
    pickTitleMany: "Which Second Brain do you want to connect?",
    pickLedeOne: "Choose it to continue, or use an address from another computer or invitation.",
    pickLedeMany: "Choose the Second Brain you want to connect to.",
    noneFound:
      "We didn't find a Second Brain in that Cloudflare account. It may be in another account, use a different web address, or belong to a team that invited you. Paste the address you were given below.",
    unlockTitle: "Enter your sign-in details",
    unlockLede:
      "Use the password for this Second Brain, or the team sign-in token from your invitation. Connecting only saves access on this computer.",
    lostPassword: "I don't have my password",
    memberTokenHelp: "I'm a team member — ask my admin for a new token",
    memberTokenHelpTitle: "Ask your team admin for a new token",
    memberTokenHelpLede: "A token that's been replaced, or an account that's been suspended or removed, can't be repaired on this computer. Ask whoever invited you to issue a new one.",
  },
  password: {
    title: "Choose a password",
    lede:
      "Choose a password for this Second Brain. You'll use it to connect your own new computers and AI apps.",
    placeholder: "Choose a password (at least 12 characters)",
    confirmPlaceholder: "Enter the same password again",
    generateTitle: "Generate a strong password",
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
      "Save this in a password manager before continuing. We cannot show it to you later, and you'll need it to connect your own computers and AI apps.",
    footnote:
      "We check new passwords against known data breaches without ever " +
      "sending your password anywhere — only a fragment of a fingerprint " +
      "leaves this computer.",
  },
  changePassword: {
    title: "Change your password",
    lede:
      "You'll pick a new one, save it, and it replaces the old one everywhere. " +
      "Your memories, your address, and your connected AI tools are all kept.",
    notice:
      "The old password stops working as soon as this finishes. Your other " +
      "computers will ask for the new one the next time you open them.",
    signInButton: "Sign in and continue",
    signInFootnote:
      "Your Second Brain lives in your own space at Cloudflare, so we sign in " +
      "there to change it. We never see your Cloudflare password.",
    waitingLede:
      "Finish signing in to Cloudflare in the browser window that just opened, " +
      "then come back here.",
    blockedTitle: "The password can't be changed right now",
    blockedBody:
      "Your Second Brain is rebuilding how it reads your memories. Changing your " +
      "password in the middle of that can stop the rebuild partway and make a " +
      "password problem look like a failed rebuild, so it waits until the " +
      "rebuild is done.",
    // Carrying on and starting over are not equivalent here, and saying they
    // were sent people to the one that doesn't work: a restarted rebuild writes
    // a fresh unfinished record straight away, so it re-blocks within a second.
    blockedEscape:
      "If nothing is rebuilding, one was left unfinished. Open Advanced Settings " +
      "and carry it on — this clears when the rebuild finishes. Starting it over " +
      "gets there too, but it reads every memory again from the first one, so it " +
      "takes longer.",
    blockedButton: "Open Advanced Settings",
    // Only on the blocked screen, and only after an attempt that may have
    // landed. The rebuild takes away the one thing that would settle it —
    // trying again — so the sentence that says so has to come with the reason
    // the password below is still worth keeping.
    blockedMayBeLive:
      "An earlier attempt was sent to your Second Brain and never confirmed, so " +
      "the password below may already be the one that works. Save it before you " +
      "close this window. Trying again is what would settle that, and it has to " +
      "wait until the rebuild is finished.",
    lostTitle: "Your memories are safe",
    lostLede:
      "Nothing is lost. Nobody can look your password up for you — not this app, " +
      "not Cloudflare — but it can be replaced, and replacing it is how you get " +
      "back in.",
    lostBodySignedIn:
      "You're already signed in to the Cloudflare space your Second Brain lives " +
      "in, which is what decides who gets in. So you can set a new password " +
      "right now. Everything you've stored stays exactly where it is.",
    lostBodySignIn:
      "Your Second Brain lives in your own Cloudflare space, and that's what " +
      "decides who gets in. Sign in there and you can set a new password. " +
      "Everything you've stored stays exactly where it is.",
    lostNotice:
      "Anything that already has the old password will ask for the new one — " +
      "your other computers, the browser extension, the Obsidian plugin.",
    lostContinueButton: "Choose a new password",
    // Word for word the same as connectExisting.signInButton: it is the same
    // act with the same consequence, and two labels would read as two things.
    lostSignInButton: "Sign in with Cloudflare",
    pickBrainLedeOne: "Set a new password on it, or go back and pick another.",
    pickBrainLedeMany: "Pick the one you've lost the password for.",
    addressTitle: "What's your Second Brain's address?",
    addressLede:
      "We couldn't find it in that space. Enter the address and we'll set a new " +
      "password on it — no current password needed.",
    addressLedeManual:
      "Enter the address of the Second Brain you want a new password for — no " +
      "current password needed.",
    pickTitle: "Choose a new password",
    // Not "the copy you keep is the only copy". This computer keeps one too —
    // in secure storage, and in the CLI's plaintext config file when that
    // exists — and someone reasoning about where their secret lives has to be
    // told the truth about that. What is true is that nobody will show it to
    // them again.
    pickLede:
      "This one replaces the old one. Cloudflare can't show it to you again, and " +
      "neither can we, so keep your own copy of it.",
    generatedNote: "We've made a strong one for you. Type over it if you'd rather choose your own.",
    pickNotice: "The old password stops working the moment this takes effect.",
    saveTitle: "Save this somewhere",
    saveLede:
      "Once it's set, nothing in this app or at Cloudflare will show it to you " +
      "again. It stays on screen in this window until you close it, and after " +
      "that you'll need the copy you kept.",
    passwordLabel: "Your new password",
    saveAdvice:
      "A password manager is the right place for it. If you keep it anywhere " +
      "else, keep it somewhere you'd trust with the key to everything you've " +
      "written down.",
    saveConfirm: "I've saved it — change my password",
    saveBack: "Choose a different one",
    progressTitle: "Changing your password",
    progressLede: "This takes up to a minute or two. Leave this window open.",
    stepSend: "Setting the new password",
    stepConfirm: "Waiting for your Second Brain to accept it",
    stepLocal: "Saving it on this computer",
    doneTitle: "Your password has been changed",
    doneTitleLost: "You're back in",
    doneLede:
      "This computer is using the new password already. Your memories, your " +
      "address, and everything you've connected are unchanged.",
    doneNeedsHead: "What will ask for the new password",
    doneNeeds1: "Your other computers, the next time you open Second Brain on them.",
    // On this computer as well: a password change writes to secure storage, the
    // brain command's config and the open dashboard window, and nothing else.
    doneNeeds2:
      "The browser extension and the Obsidian plugin, on this computer as well " +
      "as any other. Each keeps its own copy, and this change doesn't reach them.",
    doneNeeds3: "The brain command in a terminal on any other computer.",
    doneNeeds4: "Any browser tab where you opened your dashboard directly.",
    doneKeptHead: "What is still connected",
    // Not "none of them ever used your password". A tool set up by pasting the
    // password straight in — which is the documented route for anything that
    // can't open a browser — did use it, does break, and cannot be reached by
    // Disconnect either, because it has nothing stored to disconnect.
    doneKept:
      "AI tools you connected by signing in through your connection link are " +
      "still connected and still working. Each one was given its own access at " +
      "the time, separate from your password, so changing it doesn't reach them. " +
      "Anything you connected by pasting the password itself is in the list " +
      "above — it will ask for the new one.",
    doneLeak:
      "If you changed your password because someone else may have had it, those " +
      "connections are the one thing this didn't close. Disconnecting them makes " +
      "every tool ask to be connected again.",
    doneDisconnectButton: "Disconnect AI tools…",
    doneShow: "Show my new password",
    doneHide: "Hide it",
    failNotSentTitle: "Nothing was changed",
    failNotSentBody:
      "The new password never reached your Second Brain, so your old one still " +
      "works and everything is exactly as it was. Trying again is safe.",
    failNotSentLabel: "The password you chose — not in use",
    failDetail: "What went wrong: {detail}",
    failUnsureTitle: "Your new password may already be in use",
    failUnsureBody:
      "The change was sent to your Second Brain, but it didn't confirm in time, " +
      "so we can't tell you which password is live. Save the one below before " +
      "you do anything else — it may be the one that works now.",
    failUnsureRetry:
      "Try again. Setting the same password a second time changes nothing if it " +
      "already went through, and finishes the job if it didn't — either way you " +
      "end up knowing.",
    failUnsureFootnote:
      "This computer hasn't been updated yet, so it may ask for a password too. " +
      "If it does, use the one above.",
    failUnsureLeave: "Leave it for now",
    recheckButton: "Check again",
    recheckConfirmed:
      "Your Second Brain answers to the new password, so that part is done. This " +
      "computer hasn't saved it yet — try again to finish, and nothing on your " +
      "Second Brain changes.",
    recheckUnconfirmed:
      "Your Second Brain still doesn't answer to the new password. It may need " +
      "another moment, or the change may not have landed — trying again settles " +
      "it either way.",
    // The third answer, and not the same as "no". Collapsing a failed probe
    // into "still doesn't answer" reports a question that was never asked as an
    // answer of no.
    recheckUnreachable:
      "We couldn't reach your Second Brain to ask, so this settles nothing " +
      "either way — the change may still have gone through. Check again in a " +
      "moment, or go straight to trying the change again.",
    failLocalTitle: "Your password was changed, but not saved on this computer",
    failLocalTitlePartial:
      "Your password was changed, but something on this computer still has the old one",
    failLocalBody:
      "Your Second Brain is using the new password. This computer couldn't store " +
      "it, so it can't open your Second Brain until you connect again with the " +
      "new one — save it now, if you haven't.",
    failLocalCli:
      "The brain command in your terminal is still set to the old password. Run " +
      "brain setup to point it at the new one.",
    failLocalDashboard:
      "The Second Brain window that's already open is still using the old " +
      "password. Close it and open it again.",
    failLocalReconnect: "Connect this computer again",
    leaveWarn:
      "This is the last screen that shows this password. If you haven't put it " +
      "somewhere safe, do it now.",
    leaveConfirm: "I've saved it — leave",
    leaveKeep: "Stay here",
  },
  passwordChangedElsewhere: {
    title: "Your password was changed on another computer",
    lede:
      "Your Second Brain has a new password, so the one saved on this computer " +
      "no longer opens it. Nothing was lost and nothing was deleted — this " +
      "computer just needs the new one.",
    body:
      "You'll find it wherever you saved it when you changed it. It's the same " +
      "Second Brain at the same address.",
    findAgain: "Find a different Second Brain",
    findAgainHint:
      "Signs in to Cloudflare and looks for it, in case you're connecting to a " +
      "different one now.",
    footnote:
      "Don't have the new one — or didn't change it yourself? Choosing a new " +
      "password closes the old one for good.",
  },
  cloudflare: {
    title: "Create or connect your Cloudflare account",
    lede:
      "Cloudflare will host this new Second Brain in an account you control. Sign in to an existing Cloudflare account, or create a free one in the browser window that opens.",
    signIn: "Open Cloudflare to create my Second Brain",
    footnote: "Cloudflare handles the sign-in. This app never sees your Cloudflare password.",
    waitingTitle: "Finish signing in in your browser",
    waitingLede:
      "Complete the sign-in or account creation in the browser window. When it is finished, return here.",
    watchingSignIn: "Waiting for Cloudflare sign-in to finish",
    pickerTitle: "Choose a Cloudflare account",
    pickerLede: "Choose the account that will own and host this Second Brain.",
  },
  /**
   * The two `start_provisioning` preflight guards (#P0-1): a Second Brain
   * already proven to exist on the chosen account, or a fixed resource name
   * already taken by something unproven. Neither screen ever mutates anything
   * — that is the whole point of the guard they render for.
   */
  guard: {
    existingBrainTitle: "We found your existing Second Brain",
    existingBrainConnect: "Connect to it",
    conflictTitle: "That name is already in use",
    conflictChooseAnother: "Choose another account",
  },
  progress: {
    title: "Creating your Second Brain",
    lede: "This usually takes a few minutes. Keep this window open while we create your Second Brain; we'll show each step as it finishes.",
    stepSpace: "Preparing your Cloudflare account",
    stepMemory: "Creating secure memory storage",
    stepRecall: "Preparing search for your memories",
    stepFinish: "Final checks",
    /** Appended after the step label as `${label}: ${word}` for a screen
     *  reader — the icon swap alone (bullet/spinner/check/bang) says nothing
     *  to VoiceOver (#P0-7). */
    stepInProgress: "in progress",
    stepDone: "done",
    stepFailed: "failed",
  },
  tools: {
    title: "Connect AI apps",
    lede: "Connect any AI apps you use now, or skip this step and add them later. Each connected app can use the same Second Brain.",
    autoSetup: "Adds this computer's connection details to the app automatically.",
    notOnComputer: "Not installed on this computer. You can connect it later from Connections.",
    doneRestart: "Done — restart the tool to start using your Second Brain.",
    cliSub: "Optional: use Second Brain from a terminal (for people who use command-line tools).",
    setupCli: "Set up CLI",
    settingUp: "Setting up…",
    cliDone: "Done. The brain command is ready in your terminal.",
    installing: "Installing…",
    installed: "Installed ✓",
    reopenTerminal: "The brain command is ready. Reopen your terminal if it isn't found yet.",
    configSaved: "Config saved ✓",
    configSavedInstallFailed: "Your connection details were saved, but the optional terminal command was not installed. Your Second Brain still works in the app.",
    configSavedNoNpm: "Config saved. Install Node.js, then run: ",
    pasteInSettings: "Copy the link, then paste it under connectors in settings.",
    claudeCode: "Claude Code",
    cursor: "Cursor",
    cliTitle: "Second Brain CLI",
    chatgpt: "ChatGPT",
    claudeWeb: "Claude (web & desktop)",
  },
  details: {
    title: "Connections",
    lede:
      "This window is where you connect things to your Second Brain. " +
      "Your memories themselves live in the dashboard, which opens in its own window.",
    notSetupTitle: "Not set up yet",
    notSetupLede: "Finish creating or connecting your Second Brain first. Connection details will appear here when setup is complete.",
    addressLabel: "Your Second Brain address",
    addressDesc: "Your private web dashboard, and where you connect new tools. Save it somewhere safe.",
    mcpLabel: "Your connection link (for AI tools)",
    mcpDesc: "Paste this into any AI tool that supports connectors.",
    passwordLabel: "Your password",
    // "Nothing can read it back, not even this app" was true of Cloudflare and
    // false of the app: it is in this computer's secure storage, and this very
    // feature writes it as plain text to the brain command's config file. A
    // card whose whole job is to explain where a secret lives has to say so.
    passwordDesc:
      "The key to your Second Brain. It isn't shown here, but this computer " +
      "keeps a copy: in its secure storage, and in the brain command's settings " +
      "file if you set that up. Cloudflare can't read it back at all. If you " +
      "want a different one, you can set one now.",
    passwordButton: "Change my password",
    disconnectLabel: "Disconnect your AI tools",
    // Not "this closes all of it at once". Tools set up by pasting the password
    // have no keys here to delete, so this route cannot reach them at all —
    // changing the password is what closes those.
    disconnectDesc:
      "AI tools that signed in through your connection link were each given " +
      "their own access, separate from your password. This closes all of those " +
      "at once. Anything you connected by pasting your password instead isn't " +
      "affected — changing your password is what closes those. Your memories " +
      "and your password stay as they are.",
    disconnectButton: "Disconnect AI tools…",
    disconnectConfirmDesc:
      "Every AI tool that signed in through your connection link — on this " +
      "computer and on any other — will need connecting again, and each one " +
      "will ask for your password when you do.",
    disconnectConfirm: "Yes, disconnect them all",
    disconnectKeep: "Keep them connected",
    disconnectWorking: "Disconnecting…",
    disconnectDone: "Disconnected. Each tool will ask to be connected again the next time you use it.",
    disconnectDoneNone:
      "No tool had signed in through your connection link, so there was nothing " +
      "to close here. Tools that use your password are unaffected — changing " +
      "your password is what closes those.",
    disconnectFailed:
      "Some AI-app connections could not be closed. Connections already closed stay closed. Try again to close the remaining connections.",
    connectToolsTitle: "Connect your AI tools",
    connectToolsDesc:
      "Tools on this computer connect with one click. For anything else, " +
      "paste your connection link into the tool's connector settings — " +
      "it will ask for your password the first time.",
    integrationsTitle: "Integrations",
    integrationsDesc: "Bring in notes and pages from the tools you already use.",
    navConnection: "Connection",
    navTools: "AI tools",
    navIntegrations: "Integrations",
    navComputer: "This computer",
    updateLabel: "A newer Second Brain is available ({version})",
    updateDesc:
      "Update to get the latest improvements. Your memories, password, and connected tools are kept.",
    // Read by anyone who cannot perform the update: the redeploy happens inside
    // the Cloudflare account the brain lives in, and only the person who
    // created it has one. Says who can, rather than going quiet — a member
    // whose brain is behind is missing features and deserves the reason.
    updateDescOther:
      "Whoever set this brain up needs to update it — the update runs in their " +
      "own Cloudflare account, so it isn't something this computer can do. " +
      "Nothing you've saved is affected in the meantime.",
    // The third case, and the honest version of it: this brain is running a
    // version that predates the check, so the app genuinely does not know
    // whether the person reading this created it. The button is offered anyway
    // because updating is the only thing that fixes the check — but the copy
    // must not pretend the app has confirmed anything.
    updateDescLegacy:
      "This brain is running an older version that can't yet tell this app who " +
      "you are, so the update is offered to everyone who opens this window. It " +
      "only runs in the Cloudflare account the brain was created in — if that " +
      "isn't yours, it will stop and say so. Updating once teaches this brain " +
      "to answer, and this note goes away.",
    updateButton: "Update my Second Brain",
    allSetTitle: "Your Second Brain is ready",
    allSetLede: "Save these two links if you plan to connect more devices or AI apps. You can also find them later in this app under Connections.",
    allSetTeamLede:
      "Save these two links, then invite your team from the dashboard. Each person gets their own sign-in token.",
    teamCardLabel: "Your team's Second Brain",
    teamCardBody:
      "You set up this team. Open the dashboard and choose Team to invite people. Each person receives a separate sign-in token. Their private memories stay private; memories they choose to share are visible to the team.",
    teamCardBodyAdmin:
      "You can invite people from the dashboard's Team area. Only the person who originally set up this Second Brain can change its password, because it is in their Cloudflare account.",
    teamCardBodyMember:
      "You are connected as a team member. Your personal memories stay private. Memories you choose to share can be found by everyone on the team. Ask a team administrator for a new sign-in token if this one stops working.",
    openDashboard: "Open my Second Brain dashboard",
  },
  integrations: {
    extensionTitle: "Browser extension",
    extensionSub: "Capture any page or highlight. Paste your address and password into its setup.",
    getExtension: "Get the extension",
    obsidianTitle: "Obsidian sync",
    obsidianSub: "Keep your vault notes and your Second Brain in sync.",
    openObsidian: "Open in Obsidian",
    getPlugin: "Get the plugin",
    connectedPlain: "Connected.",
    connectedTo: "Connected to {workspace}.",
    syncNow: "Sync now",
    syncing: "Syncing…",
    manage: "Manage",
    setUp: "Set up",
    appsTitle: "Apps",
    back: "All integrations",
    categoryKnowledge: "Knowledge",
    categoryCalendar: "Calendars",
    categoryEmail: "Email",
    categoryOther: "Other",
  },
  logout: {
    button: "Log out of this computer",
    confirm: "Yes, log out",
    keep: "Keep me signed in",
    desc:
      "You can reconnect with the address and password—or, for a team brain, the sign-in token—provided to you.",
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
    updatingLede: "This usually takes a minute. Keep this window open while the update finishes.",
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
  mascot: {
    dismiss: "Dismiss",
    welcome: {
      intro:
        "Hey — I'm Ridge. Two doors here: build a brand-new memory, or plug into one that already exists — yours, or one someone invited you to. Either way I'll walk you through it.",
      guard:
        "One thing worth asking yourself first: do you already have a Second Brain running somewhere? If yes, this button isn't the one you want — \"Already have a Second Brain?\" below is safer. Building fresh in the same Cloudflare account as an existing one can knock out its password.",
    },
    password: {
      intro: "This one's worth getting right — a password manager, the moment you pick it.",
      breached:
        "That one's shown up in a breach list somewhere, which means it isn't private anymore. Try a different one, or let the generator make a fresh one.",
    },
    cloudflare: {
      why:
        "This is the one real account you'll need — Cloudflare, free, and it's genuinely yours: your memories live in your own space there, not ours. Sign in if you've got one, or create one in the window that opens.",
      waiting: "Take your time in the browser — I'll be here when you're back.",
      pickerWhy:
        "More than one Cloudflare account on that login. Pick carefully — once you continue, this starts building for real in that account.",
    },
    progress: {
      intro:
        "Building your space now — this is the only step that takes real time. I'll let you know the moment it's done.",
    },
    tools: {
      intro:
        "If Claude Code or Cursor turned up installed, one click connects them. Everything else takes copying one link. None of this is required right now — Connections has it all again later.",
    },
    details: {
      allSetSolo:
        "That's it — your Second Brain is live. These two links are worth keeping somewhere safe; everything else you can always find again in Connections.",
      allSetTeam:
        "Team brain's up. Grab those two links, then find the Team tab in your dashboard whenever you're ready to invite people — that part's on your own time.",
      allSetMember:
        "You're in. Your own memories stay private by default — anything you choose to share lands where the rest of the team can see it.",
    },
    connect: {
      fork:
        "Quick check before you pick one: is this Second Brain yours, or did someone invite you to theirs? Yours → Cloudflare sign-in below finds it fast. Invited → skip that, tap \"I have an address or team sign-in token,\" and use the token from your invite instead of a password.",
    },
    discover: {
      searching:
        "Looking through your Cloudflare account for anything that answers like a Second Brain — shouldn't take long.",
    },
    brainPicker: {
      one: "Found one — is this it? If not, there's a manual option below.",
      many: "A few turned up. The address is the only thing that tells them apart — pick the one you recognize.",
    },
    unlock: {
      hint: "Password goes here — or, if this is a team you were invited to, the token from your invite email goes in the same box.",
    },
    manualEntry: {
      combined:
        "Paste the address exactly as you have it — from Connection details on another computer, an invite email, or wherever you saved it. If a token came with it, that goes in the password box below. Paste rather than retype — tokens are long, and a clipped copy reads to the brain as a wrong password.",
      insecureHttp:
        "That address starts with http, not https — this app will still try it, but your password would travel unencrypted to get there. Almost certainly a typo; add the 's'.",
    },
    existingTeam: {
      repeatQuestion:
        "Seeing this again? You may have already answered it on another computer — this brain hasn't recorded a choice yet. Answering doesn't undo anything you picked before.",
    },
    rotation: {
      intro:
        "Nothing's lost — a new password gets you back in. I'll stay out of your way for the rest of this; these screens say exactly what's true at each step.",
    },
    error: {
      provisioningHonest:
        "That stopped partway through. Setup may have already created some of your Second Brain in your Cloudflare account. Retrying is usually fine once; if it keeps happening, it's worth checking your Cloudflare dashboard before trying again.",
      wrongCredentialMemberAware:
        "That didn't match — worth knowing, this same message shows up whether it's a typo, or a token your admin has since replaced. If you're using an invite token rather than a password you chose, \"I don't have my password\" below won't help; that's for the brain's owner. The real fix for a dead token is asking your admin for a new one.",
      cfSignIn: "Cloudflare didn't come back with a yes. Sign in again — this hasn't touched anything yet.",
      discoverFailed:
        "Couldn't search automatically, but that's not a dead end — the manual box below works exactly the same way.",
      rotateNotSent: "Nothing changed — your old password's still good. Safe to retry.",
      rotateUnsure:
        "This one honestly isn't settled yet. Save the password on screen before anything else, then try again — that either finishes the job or confirms it already did.",
      rotateBlocked:
        "A rebuild's using the brain right now, so the password has to wait. Advanced Settings is where to nudge that along.",
      rotateLocal: "Your Second Brain already has the new password — this computer just needs to catch up.",
      staleLocal:
        "Your Second Brain got a new password somewhere else. Nothing broke — this computer just needs it too.",
      disconnectPartial:
        "Some of those didn't close out. The ones that did are staying closed, so trying again only chases what's left.",
      clipboard: "Didn't copy — select the text and grab it by hand this once.",
    },
  },
};
