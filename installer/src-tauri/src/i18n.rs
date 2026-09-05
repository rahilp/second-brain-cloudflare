//! Native UI strings (menu, tray, dialogs, user-facing command errors).
//! Kept in Rust so they work in every window, including the remote dashboard
//! wrapper which has no bundled webview i18n.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

const LOCALE_FILE: &str = "locale";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    En,
    It,
}

impl Locale {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_lowercase().as_str() {
            "en" => Some(Self::En),
            "it" => Some(Self::It),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::It => "it",
        }
    }

    /// Same heuristic as the webview: `it*` → Italian, otherwise English.
    pub fn from_system() -> Self {
        #[cfg(target_os = "windows")]
        if let Some(locale) = windows_ui_language() {
            return locale;
        }
        for key in ["LANG", "LC_ALL", "LC_MESSAGES", "LANGUAGE"] {
            if let Ok(lang) = std::env::var(key) {
                if lang.to_lowercase().starts_with("it") {
                    return Self::It;
                }
            }
        }
        Self::En
    }
}

#[cfg(target_os = "windows")]
fn windows_ui_language() -> Option<Locale> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetUserDefaultUILanguage() -> u16;
    }
  // Italian primary language id is 0x10 (it-IT 0x0410, it-CH 0x0810).
    let lang = unsafe { GetUserDefaultUILanguage() };
    if lang & 0x3FF == 0x10 {
        Some(Locale::It)
    } else {
        None
    }
}

/// Keys for native strings. User-facing command errors use the `Error*` variants.
#[derive(Debug, Clone, Copy)]
pub enum Key {
    // Menu / tray
    MenuOpenDashboard,
    MenuConnections,
    MenuSyncNotion,
    MenuCheckUpdates,
    MenuLogout,
    SubmenuConnections,
    MenuFile,
    MenuEdit,
    MenuView,
    MenuWindow,
    MenuHelp,
    MenuSettings,
    WindowSettings,
    SettingsButtonLabel,
    SettingsButtonTooltip,
    ErrorBrainNeedsUpdateForSettings,
    TrayOpen,
    TrayQuit,
    CreditsCreatedBy,
    CreditsMaintainersLabel,
    OAuthSuccessTitle,
    OAuthSuccessBody,
    OAuthDeniedTitle,
    OAuthDeniedBody,
    // Dialogs
    LogoutTitle,
    LogoutMessage,
    LogoutConfirm,
    Cancel,
    NotionSyncTitle,
    AppUpdateUpToDateTitle,
    AppUpdateUpToDateMessage,
    AppUpdateCheckFailedTitle,
    AppUpdateCheckFailedMessage,
    AppUpdateAvailableTitle,
    AppUpdateAvailableMessage,
    AppUpdateWhatsNew,
    AppUpdateNow,
    AppUpdateLater,
    AppUpdateFailedTitle,
    AppUpdateFailedMessage,
    WorkerUpdateTitle,
    WorkerUpdateMessage,
    OpenDashboardFailed,
    OpenDashboardNotSetup,
    // Window / injected UI
    WindowSecondBrain,
    WindowConnections,
    ConnectionsButtonLabel,
    ConnectionsButtonTooltip,
    // Command errors
    ErrorBadUrl,
    ErrorEmptyPassword,
    ErrorWrongPassword,
    ErrorNotABrain,
    ErrorCantReach,
    ErrorSetupNotFinished,
    ErrorPasswordTooShort,
    ErrorFriendlyRetry,
    ErrorSecureStoreSetup,
    ErrorSecureStoreConnect,
    ErrorUnknownTool,
    ErrorNoHomeFolder,
    ErrorMcpConfigFailed,
    ErrorCliConfigFailed,
    ErrorInstallInterrupted,
    ErrorClipboardFailed,
    ErrorOpenWindowFailed,
    ErrorCfNoAccount,
    ErrorCfSignInFirst,
    ErrorCfSignInExpired,
    ErrorNotionSynced,
    ErrorNotionUpToDate,
    ErrorCfAccountListFailed,
    ErrorBrainNeedsUpdateForMigration,
    ErrorUnknownEmbeddingModel,
    ErrorMigrationHalfSwitched,
    ErrorCannotDeleteLiveIndex,
    ErrorNoOldIndexToFree,
    ErrorCfNoSubdomain,
    ErrorCfDiscoverFailed,
    ErrorChoosePasswordFirst,
    ErrorLinkNotAllowed,
    ErrorOpenBrowserFailed,
    ErrorReachBrain,
    ErrorComputerNotSetup,
    ErrorCustomDomain,
    ErrorWrongCfAccount,
    ErrorBrainRefusedPassword,
    ErrorProvisioningDetail,
    ErrorBrainHttpStatus,
    ErrorBrainUnexpected,
    ErrorNotionSyncFailed,
    // Changing the password (#235). Each of these is a {detail} inside a screen
    // the webview owns, never a screen of its own — every failure state in that
    // flow has to carry the new password, which a bare error string cannot do.
    ErrorRotateBlocked,
    ErrorRotateNeedsHttps,
    ErrorRotateNotConfirmed,
    ErrorRotateSecureStore,
    ErrorNeedsHttps,
    GuardExistingBrain,
    GuardNameConflict,
    ErrorInvalidLocale,
}

pub fn t(locale: Locale, key: Key) -> &'static str {
    match (locale, key) {
        // Menu / tray — EN
        (Locale::En, Key::MenuOpenDashboard) => "Open Dashboard",
        (Locale::En, Key::MenuConnections) => "Connections…",
        (Locale::En, Key::MenuSyncNotion) => "Sync Notion now",
        (Locale::En, Key::MenuCheckUpdates) => "Check for updates…",
        (Locale::En, Key::MenuLogout) => "Log out…",
        (Locale::En, Key::SubmenuConnections) => "Connections",
        (Locale::En, Key::MenuFile) => "File",
        (Locale::En, Key::MenuEdit) => "Edit",
        (Locale::En, Key::MenuView) => "View",
        (Locale::En, Key::MenuWindow) => "Window",
        (Locale::En, Key::MenuHelp) => "Help",
        (Locale::En, Key::MenuSettings) => "Advanced Settings…",
        (Locale::En, Key::WindowSettings) => "Advanced Settings",
        (Locale::En, Key::SettingsButtonLabel) => "Advanced Settings",
        (Locale::En, Key::SettingsButtonTooltip) => "Tune how your Second Brain remembers and recalls",
        (Locale::En, Key::ErrorBrainNeedsUpdateForSettings) => {
            "This Second Brain needs an update before settings are available. If you set it up, open Connections and update it. Otherwise, ask the person who set it up."
        }
        (Locale::En, Key::TrayOpen) => "Open Second Brain",
        (Locale::En, Key::TrayQuit) => "Quit",
        (Locale::En, Key::CreditsCreatedBy) => "Created by",
        (Locale::En, Key::CreditsMaintainersLabel) => "Maintainers:",
        (Locale::En, Key::OAuthSuccessTitle) => "You&rsquo;re signed in ✓",
        (Locale::En, Key::OAuthSuccessBody) =>
            "You can close this tab and return to the Second Brain app.",
        (Locale::En, Key::OAuthDeniedTitle) => "Sign-in cancelled",
        (Locale::En, Key::OAuthDeniedBody) =>
            "You can close this tab. Head back to the Second Brain app to try again.",
        // Dialogs — EN
        (Locale::En, Key::LogoutTitle) => "Log out",
        (Locale::En, Key::LogoutMessage) => {
            "Log out of this computer?\n\nYour Second Brain and all its memories stay safe. \
             You can reconnect anytime with your address and password."
        }
        (Locale::En, Key::LogoutConfirm) => "Log out",
        (Locale::En, Key::Cancel) => "Cancel",
        (Locale::En, Key::NotionSyncTitle) => "Notion sync",
        (Locale::En, Key::AppUpdateUpToDateTitle) => "You're up to date",
        (Locale::En, Key::AppUpdateUpToDateMessage) => {
            "You have the latest version of Second Brain."
        }
        (Locale::En, Key::AppUpdateCheckFailedTitle) => "Couldn't check for updates",
        (Locale::En, Key::AppUpdateCheckFailedMessage) => {
            "We couldn't check for updates right now. Please try again later."
        }
        (Locale::En, Key::AppUpdateAvailableTitle) => "Update available",
        (Locale::En, Key::AppUpdateAvailableMessage) => {
            "Second Brain {version} is available.\n\nUpdate now? The app will download it and restart."
        }
        (Locale::En, Key::AppUpdateWhatsNew) => "\n\nWhat's new:\n",
        (Locale::En, Key::AppUpdateNow) => "Update now",
        (Locale::En, Key::AppUpdateLater) => "Later",
        (Locale::En, Key::AppUpdateFailedTitle) => "Update didn't finish",
        (Locale::En, Key::AppUpdateFailedMessage) => {
            "Something went wrong installing the update. Your app is unchanged — please try again later."
        }
        (Locale::En, Key::WorkerUpdateTitle) => "Update your Second Brain",
        (Locale::En, Key::WorkerUpdateMessage) => {
            "A newer version of your Second Brain is available (version {version}).\n\n\
             Update now? You'll sign in to Cloudflare once. Your memories, password, \
             and connected tools are kept."
        }
        (Locale::En, Key::OpenDashboardFailed) => "We couldn't open the Second Brain dashboard. Try 'Open my Second Brain dashboard' again. If it still won't open, restart the app.",
        (Locale::En, Key::OpenDashboardNotSetup) => "Setup is not finished yet. Return to the Second Brain app and complete setup.",
        // Window / injected UI — EN
        (Locale::En, Key::WindowSecondBrain) => "Second Brain",
        (Locale::En, Key::WindowConnections) => "Connections",
        (Locale::En, Key::ConnectionsButtonLabel) => "Connections",
        (Locale::En, Key::ConnectionsButtonTooltip) => {
            "Connection details, AI tools, and integrations"
        }
        // Command errors — EN
        (Locale::En, Key::ErrorBadUrl) => {
            "That doesn't look like a complete web address. Paste the full address from your other computer or team invitation."
        }
        (Locale::En, Key::ErrorEmptyPassword) => "Enter the Second Brain password or the team sign-in token from your invitation.",
        (Locale::En, Key::ErrorWrongPassword) => {
            "That password or team sign-in token does not work for this Second Brain. Check the invitation or password and try again."
        }
        (Locale::En, Key::ErrorNotABrain) => {
            "We couldn't find a Second Brain at that address. Check the link in your invitation or Connection details, then try again."
        }
        (Locale::En, Key::ErrorCantReach) => {
            "We couldn't reach that address. Check it and your internet connection, then try again."
        }
        (Locale::En, Key::ErrorSetupNotFinished) => "Setup is not finished yet. Return to the Second Brain app and complete setup.",
        (Locale::En, Key::ErrorPasswordTooShort) => "Your password needs at least {min} characters.",
        (Locale::En, Key::ErrorFriendlyRetry) => {
            "Setup could not finish. You can try again; this app will not delete any Second Brain data already created."
        }
        (Locale::En, Key::ErrorSecureStoreSetup) => {
            "Your Second Brain was created, but this computer could not save its connection details. Keep your address and password, then connect this computer again."
        }
        (Locale::En, Key::ErrorSecureStoreConnect) => {
            "The connection worked, but this computer could not save it. Keep the address and password or team sign-in token, then connect again next time."
        }
        (Locale::En, Key::ErrorUnknownTool) => "This AI tool is not available for automatic setup. Copy your connection link and add it in the tool's settings instead.",
        (Locale::En, Key::ErrorNoHomeFolder) => "We couldn't find the folder this computer uses for app settings. Restart the app and try again.",
        (Locale::En, Key::ErrorMcpConfigFailed) => {
            "We couldn't update that tool's settings. You can paste the link manually instead."
        }
        (Locale::En, Key::ErrorCliConfigFailed) => {
            "We couldn't finish setting up the optional terminal command. Your Second Brain still works in the app."
        }
        (Locale::En, Key::ErrorInstallInterrupted) => "The installation stopped before it finished. Open the installer again and choose Try again.",
        (Locale::En, Key::ErrorClipboardFailed) => "We couldn't copy that automatically. Select the link and copy it yourself.",
        (Locale::En, Key::ErrorOpenWindowFailed) => "We couldn't open the update window. Try again from Connections.",
        (Locale::En, Key::ErrorCfNoAccount) => {
            "This Cloudflare sign-in does not have an account where a Second Brain can be created. Create or choose a Cloudflare account, then sign in again."
        }
        (Locale::En, Key::ErrorCfSignInFirst) => "Please sign in to Cloudflare first.",
        (Locale::En, Key::ErrorCfSignInExpired) => {
            "Your Cloudflare sign-in expired. Please sign in again."
        }
        (Locale::En, Key::ErrorNotionSynced) => "Synced {count} change(s) from Notion.",
        (Locale::En, Key::ErrorNotionUpToDate) => "Notion is already up to date.",
        (Locale::En, Key::ErrorCfAccountListFailed) => {
            "You signed in, but we couldn't read your Cloudflare accounts. Try signing in again."
        }
        (Locale::En, Key::ErrorMigrationHalfSwitched) => {
            "Your Second Brain has switched to the new way of reading, but finishing the \
switch didn't complete. Your memories are safe and nothing was deleted — reopen this \
window and carry on, or search will stay incomplete."
        }
        (Locale::En, Key::ErrorUnknownEmbeddingModel) => {
            "This app can't change the current search setting. Update your Second Brain, then try again."
        }
        (Locale::En, Key::ErrorNoOldIndexToFree) => {
            "There's no leftover search data to free up. Nothing was changed."
        }
        (Locale::En, Key::ErrorCannotDeleteLiveIndex) => {
            "That's the search data your Second Brain is using right now, so it can't be \
freed up. Nothing was changed."
        }
        (Locale::En, Key::ErrorBrainNeedsUpdateForMigration) => {
            "Your Second Brain needs updating before it can change how it reads memories. \
Update it first, then try again."
        }
        (Locale::En, Key::ErrorCfNoSubdomain) => {
            "We couldn't find a web address for this Cloudflare account. Paste your Second Brain address instead."
        }
        (Locale::En, Key::ErrorCfDiscoverFailed) => {
            "We couldn't search this Cloudflare account right now. Paste your Second Brain address instead."
        }
        (Locale::En, Key::ErrorChoosePasswordFirst) => "Please choose a password first.",
        (Locale::En, Key::ErrorLinkNotAllowed) => "This link can't be opened from this part of the app. Copy it and open it in your web browser.",
        (Locale::En, Key::ErrorOpenBrowserFailed) => "We couldn't open your web browser. Open your browser yourself, then try the sign-in again from the app.",
        (Locale::En, Key::ErrorReachBrain) => "We couldn't reach your Second Brain. Check your internet connection and try again.",
        (Locale::En, Key::ErrorComputerNotSetup) => "This computer is not connected to a Second Brain yet. Return to setup and choose Create or Connect.",
        (Locale::En, Key::ErrorCustomDomain) => {
            "This Second Brain uses a web address this app can't update. If you set it up, update it from the dashboard; otherwise ask the person who set it up."
        }
        (Locale::En, Key::ErrorWrongCfAccount) => {
            "This Cloudflare account does not host this Second Brain. Sign in with the account used to create it. If someone else created it, ask them to update it."
        }
        (Locale::En, Key::ErrorBrainRefusedPassword) => {
            "Your Second Brain wouldn't accept the password this computer has saved. If its \
             password was changed somewhere else, use that one instead."
        }
        (Locale::En, Key::ErrorProvisioningDetail) => "Setup stopped while creating your Second Brain. Try again. If it keeps happening, contact support and include the time of this attempt.",
        (Locale::En, Key::ErrorBrainHttpStatus) => "Your Second Brain did not respond as expected. Try again in a moment.",
        (Locale::En, Key::ErrorBrainUnexpected) => "Your Second Brain sent a response this app could not use. Try again in a moment.",
        (Locale::En, Key::ErrorNotionSyncFailed) => {
            "The sync didn't finish. Please try again from the dashboard."
        }
        (Locale::En, Key::ErrorRotateBlocked) => {
            "Your Second Brain is rebuilding how it reads your memories, so its password \
can't be changed just now."
        }
        // Deliberately not ErrorBadUrl: `http://my-brain.acme.workers.dev` is a
        // perfectly good address, and telling someone it does not look like one
        // sends them hunting for a typo that is not there.
        (Locale::En, Key::ErrorRotateNeedsHttps) => {
            "Your Second Brain's address has to start with https://. A plain http:// address \
would send your new password unprotected."
        }
        (Locale::En, Key::ErrorRotateNotConfirmed) => {
            "Your Second Brain didn't confirm the new password in time."
        }
        // Not ErrorSecureStoreConnect: that one says "Connected, but…", and
        // nothing was connected here — a working password was replaced.
        (Locale::En, Key::ErrorRotateSecureStore) => {
            "Your password was changed, but we couldn't save it to this device's secure storage."
        }
        (Locale::En, Key::ErrorNeedsHttps) => {
            "That address starts with http, not https. Your password would travel unencrypted. Check the address — it should begin with https://."
        }
        (Locale::En, Key::GuardExistingBrain) => "We found your existing Second Brain. Connect to it with its password or a team sign-in token.",
        (Locale::En, Key::GuardNameConflict) => {
            "This Cloudflare account already has {kind} using the name this installer needs. Nothing was changed. Choose another account or go back."
        }
        (Locale::En, Key::ErrorInvalidLocale) => {
            "We couldn't change the app language. Try again."
        }

        // Menu / tray — IT
        (Locale::It, Key::MenuOpenDashboard) => "Apri dashboard",
        (Locale::It, Key::MenuConnections) => "Connessioni…",
        (Locale::It, Key::MenuSyncNotion) => "Sincronizza Notion",
        (Locale::It, Key::MenuCheckUpdates) => "Controlla aggiornamenti…",
        (Locale::It, Key::MenuLogout) => "Esci…",
        (Locale::It, Key::SubmenuConnections) => "Connessioni",
        (Locale::It, Key::MenuFile) => "File",
        (Locale::It, Key::MenuEdit) => "Modifica",
        (Locale::It, Key::MenuView) => "Visualizza",
        (Locale::It, Key::MenuWindow) => "Finestra",
        (Locale::It, Key::MenuHelp) => "Aiuto",
        (Locale::It, Key::MenuSettings) => "Impostazioni avanzate…",
        (Locale::It, Key::WindowSettings) => "Impostazioni avanzate",
        (Locale::It, Key::SettingsButtonLabel) => "Impostazioni avanzate",
        (Locale::It, Key::SettingsButtonTooltip) => "Regola come il tuo Second Brain ricorda e recupera",
        (Locale::It, Key::ErrorBrainNeedsUpdateForSettings) => {
            "Questo Second Brain deve essere aggiornato prima che le impostazioni siano disponibili. Se lo hai configurato tu, apri Connessioni e aggiornalo. Altrimenti, chiedi alla persona che lo ha configurato."
        }
        (Locale::It, Key::TrayOpen) => "Apri Second Brain",
        (Locale::It, Key::TrayQuit) => "Esci",
        (Locale::It, Key::CreditsCreatedBy) => "Creato da",
        (Locale::It, Key::CreditsMaintainersLabel) => "Manutentori:",
        (Locale::It, Key::OAuthSuccessTitle) => "Accesso effettuato ✓",
        (Locale::It, Key::OAuthSuccessBody) =>
            "Puoi chiudere questa scheda e tornare all’app Second Brain.",
        (Locale::It, Key::OAuthDeniedTitle) => "Accesso annullato",
        (Locale::It, Key::OAuthDeniedBody) =>
            "Puoi chiudere questa scheda. Torna all’app Second Brain per riprovare.",
        // Dialogs — IT
        (Locale::It, Key::LogoutTitle) => "Esci",
        (Locale::It, Key::LogoutMessage) => {
            "Uscire da questo computer?\n\nIl Second Brain e tutte le memorie restano al sicuro. \
             Puoi ricollegarti in qualsiasi momento con indirizzo e password."
        }
        (Locale::It, Key::LogoutConfirm) => "Esci",
        (Locale::It, Key::Cancel) => "Annulla",
        (Locale::It, Key::NotionSyncTitle) => "Sincronizzazione Notion",
        (Locale::It, Key::AppUpdateUpToDateTitle) => "Sei aggiornato",
        (Locale::It, Key::AppUpdateUpToDateMessage) => {
            "Hai l'ultima versione di Second Brain."
        }
        (Locale::It, Key::AppUpdateCheckFailedTitle) => "Impossibile controllare gli aggiornamenti",
        (Locale::It, Key::AppUpdateCheckFailedMessage) => {
            "Non è stato possibile controllare gli aggiornamenti. Riprova più tardi."
        }
        (Locale::It, Key::AppUpdateAvailableTitle) => "Aggiornamento disponibile",
        (Locale::It, Key::AppUpdateAvailableMessage) => {
            "Second Brain {version} è disponibile.\n\nAggiornare ora? L'app scaricherà l'aggiornamento e si riavvierà."
        }
        (Locale::It, Key::AppUpdateWhatsNew) => "\n\nNovità:\n",
        (Locale::It, Key::AppUpdateNow) => "Aggiorna ora",
        (Locale::It, Key::AppUpdateLater) => "Più tardi",
        (Locale::It, Key::AppUpdateFailedTitle) => "Aggiornamento non completato",
        (Locale::It, Key::AppUpdateFailedMessage) => {
            "Qualcosa è andato storto durante l'installazione. L'app non è cambiata — riprova più tardi."
        }
        (Locale::It, Key::WorkerUpdateTitle) => "Aggiorna il Second Brain",
        (Locale::It, Key::WorkerUpdateMessage) => {
            "È disponibile una nuova versione del Second Brain (versione {version}).\n\n\
             Aggiornare ora? Accederai a Cloudflare una volta. Memorie, password e strumenti collegati restano."
        }
        (Locale::It, Key::OpenDashboardFailed) => {
            "Non è stato possibile aprire la dashboard del Second Brain. Riprova con 'Apri la dashboard del mio Second Brain'. Se ancora non si apre, riavvia l'app."
        }
        (Locale::It, Key::OpenDashboardNotSetup) => "La configurazione non è ancora terminata. Torna all'app Second Brain e completa la configurazione.",
        // Window / injected UI — IT
        (Locale::It, Key::WindowSecondBrain) => "Second Brain",
        (Locale::It, Key::WindowConnections) => "Connessioni",
        (Locale::It, Key::ConnectionsButtonLabel) => "Connessioni",
        (Locale::It, Key::ConnectionsButtonTooltip) => {
            "Dettagli connessione, strumenti AI e integrazioni"
        }
        // Command errors — IT
        (Locale::It, Key::ErrorBadUrl) => {
            "Non sembra un indirizzo web completo. Incolla l'indirizzo completo dall'altro computer o dall'invito del team."
        }
        (Locale::It, Key::ErrorEmptyPassword) => {
            "Inserisci la password del Second Brain oppure il token di accesso del team presente nel tuo invito."
        }
        (Locale::It, Key::ErrorWrongPassword) => {
            "Questa password o questo token di accesso del team non funziona per questo Second Brain. Controlla l'invito o la password e riprova."
        }
        (Locale::It, Key::ErrorNotABrain) => {
            "Non abbiamo trovato un Second Brain a quell'indirizzo. Controlla il link nell'invito o in Dettagli connessione, poi riprova."
        }
        (Locale::It, Key::ErrorCantReach) => {
            "Impossibile raggiungere quell'indirizzo. Controlla il link e la connessione internet, poi riprova."
        }
        (Locale::It, Key::ErrorSetupNotFinished) => "La configurazione non è ancora terminata. Torna all'app Second Brain e completa la configurazione.",
        (Locale::It, Key::ErrorPasswordTooShort) => {
            "La password deve avere almeno {min} caratteri."
        }
        (Locale::It, Key::ErrorFriendlyRetry) => {
            "La configurazione non è riuscita a terminare. Puoi riprovare; questa app non eliminerà i dati del Second Brain già creati."
        }
        (Locale::It, Key::ErrorSecureStoreSetup) => {
            "Il tuo Second Brain è stato creato, ma questo computer non ha potuto salvare i suoi dettagli di connessione. Conserva indirizzo e password, poi collega di nuovo questo computer."
        }
        (Locale::It, Key::ErrorSecureStoreConnect) => {
            "Il collegamento ha funzionato, ma questo computer non ha potuto salvarlo. Conserva indirizzo e password oppure il token di accesso del team, poi collegati di nuovo la prossima volta."
        }
        (Locale::It, Key::ErrorUnknownTool) => "Questo strumento AI non è disponibile per la configurazione automatica. Copia il tuo link di connessione e aggiungilo invece nelle impostazioni dello strumento.",
        (Locale::It, Key::ErrorNoHomeFolder) => "Non è stato possibile trovare la cartella che questo computer usa per le impostazioni delle app. Riavvia l'app e riprova.",
        (Locale::It, Key::ErrorMcpConfigFailed) => {
            "Impossibile aggiornare le impostazioni dello strumento. Puoi incollare il link manualmente."
        }
        (Locale::It, Key::ErrorCliConfigFailed) => {
            "Non è stato possibile completare la configurazione del comando opzionale per il terminale. Il tuo Second Brain funziona comunque nell'app."
        }
        (Locale::It, Key::ErrorInstallInterrupted) => "L'installazione si è fermata prima di terminare. Apri di nuovo l'installer e scegli Riprova.",
        (Locale::It, Key::ErrorClipboardFailed) => "Non è stato possibile copiare automaticamente. Seleziona il link e copialo tu.",
        (Locale::It, Key::ErrorOpenWindowFailed) => {
            "Non è stato possibile aprire la finestra di aggiornamento. Riprova da Connessioni."
        }
        (Locale::It, Key::ErrorCfNoAccount) => {
            "Questo accesso Cloudflare non ha un account in cui sia possibile creare un Second Brain. Crea o scegli un account Cloudflare, poi accedi di nuovo."
        }
        (Locale::It, Key::ErrorCfSignInFirst) => "Accedi prima a Cloudflare.",
        (Locale::It, Key::ErrorCfSignInExpired) => {
            "L'accesso a Cloudflare è scaduto. Accedi di nuovo."
        }
        (Locale::It, Key::ErrorNotionSynced) => {
            "Sincronizzate {count} modifiche da Notion."
        }
        (Locale::It, Key::ErrorNotionUpToDate) => "Notion è già aggiornato.",
        (Locale::It, Key::ErrorCfAccountListFailed) => {
            "Hai effettuato l'accesso, ma non è stato possibile leggere i tuoi account Cloudflare. Prova ad accedere di nuovo."
        }
        (Locale::It, Key::ErrorMigrationHalfSwitched) => {
            "Il tuo Second Brain è passato al nuovo modo di leggere, ma il passaggio non è \
stato completato. I tuoi ricordi sono al sicuro e nulla è stato cancellato — riapri questa \
finestra e continua, altrimenti la ricerca resterà incompleta."
        }
        (Locale::It, Key::ErrorUnknownEmbeddingModel) => {
            "Questa app non può cambiare l'impostazione di ricerca corrente. Aggiorna il tuo Second Brain, poi riprova."
        }
        (Locale::It, Key::ErrorNoOldIndexToFree) => {
            "Non ci sono vecchi dati di ricerca da liberare. Nulla è stato modificato."
        }
        (Locale::It, Key::ErrorCannotDeleteLiveIndex) => {
            "Sono i dati di ricerca che il tuo Second Brain sta usando in questo momento, \
quindi non possono essere liberati. Nulla è stato modificato."
        }
        (Locale::It, Key::ErrorBrainNeedsUpdateForMigration) => {
            "Il tuo Second Brain va aggiornato prima di poter cambiare il modo in cui legge \
i ricordi. Aggiornalo, poi riprova."
        }
        (Locale::It, Key::ErrorCfNoSubdomain) => {
            "Non è stato possibile trovare un indirizzo web per questo account Cloudflare. Incolla invece l'indirizzo del tuo Second Brain."
        }
        (Locale::It, Key::ErrorCfDiscoverFailed) => {
            "Non è stato possibile cercare in questo account Cloudflare in questo momento. Incolla invece l'indirizzo del tuo Second Brain."
        }
        (Locale::It, Key::ErrorChoosePasswordFirst) => "Scegli prima una password.",
        (Locale::It, Key::ErrorLinkNotAllowed) => "Questo link non può essere aperto da questa parte dell'app. Copialo e aprilo nel browser web.",
        (Locale::It, Key::ErrorOpenBrowserFailed) => "Non è stato possibile aprire il browser web. Aprilo tu, poi prova di nuovo l'accesso dall'app.",
        (Locale::It, Key::ErrorReachBrain) => "Non è stato possibile raggiungere il tuo Second Brain. Controlla la connessione internet e riprova.",
        (Locale::It, Key::ErrorComputerNotSetup) => "Questo computer non è ancora collegato a un Second Brain. Torna alla configurazione e scegli Crea o Collega.",
        (Locale::It, Key::ErrorCustomDomain) => {
            "Questo Second Brain usa un indirizzo web che questa app non può aggiornare. Se lo hai configurato tu, aggiornalo dalla dashboard; altrimenti chiedi alla persona che lo ha configurato."
        }
        (Locale::It, Key::ErrorWrongCfAccount) => {
            "Questo account Cloudflare non ospita questo Second Brain. Accedi con l'account usato per crearlo. Se lo ha creato qualcun altro, chiedi a quella persona di aggiornarlo."
        }
        (Locale::It, Key::ErrorBrainRefusedPassword) => {
            "Il tuo Second Brain non ha accettato la password salvata su questo computer. Se la \
             password è stata cambiata su un altro dispositivo, usa quella."
        }
        (Locale::It, Key::ErrorProvisioningDetail) => "La configurazione si è fermata durante la creazione del tuo Second Brain. Riprova. Se continua a succedere, contatta il supporto e indica l'ora di questo tentativo.",
        (Locale::It, Key::ErrorBrainHttpStatus) => "Il tuo Second Brain non ha risposto come previsto. Riprova tra poco.",
        (Locale::It, Key::ErrorBrainUnexpected) => "Il tuo Second Brain ha inviato una risposta che questa app non può usare. Riprova tra poco.",
        (Locale::It, Key::ErrorNotionSyncFailed) => {
            "La sincronizzazione non è terminata. Riprova dalla dashboard."
        }
        (Locale::It, Key::ErrorRotateBlocked) => {
            "Il tuo Second Brain sta ricostruendo il modo in cui legge i tuoi ricordi, \
quindi la sua password non può essere cambiata adesso."
        }
        (Locale::It, Key::ErrorRotateNeedsHttps) => {
            "L'indirizzo del tuo Second Brain deve iniziare con https://. Un indirizzo http:// \
invierebbe la tua nuova password senza protezione."
        }
        (Locale::It, Key::ErrorRotateNotConfirmed) => {
            "Il tuo Second Brain non ha confermato la nuova password in tempo."
        }
        (Locale::It, Key::ErrorRotateSecureStore) => {
            "La password è stata cambiata, ma non è stato possibile salvarla nell'archivio \
sicuro del dispositivo."
        }
        (Locale::It, Key::ErrorNeedsHttps) => {
            "L'indirizzo inizia con http, non https. La password viaggerebbe senza crittografia. Controlla l'indirizzo: deve iniziare con https://."
        }
        (Locale::It, Key::GuardExistingBrain) => "Abbiamo trovato il tuo Second Brain esistente. Collegati con la sua password o con un token di accesso del team.",
        (Locale::It, Key::GuardNameConflict) => {
            "Questo account Cloudflare contiene già {kind} con il nome richiesto dall'installer. Non è stato modificato nulla. Scegli un altro account oppure torna indietro."
        }
        (Locale::It, Key::ErrorInvalidLocale) => {
            "Non è stato possibile cambiare la lingua dell'app. Riprova."
        }
    }
}

/// Replace `{name}` placeholders in a translated string.
pub fn t_fmt(locale: Locale, key: Key, params: &[(&str, &str)]) -> String {
    let mut s = t(locale, key).to_string();
    for (name, value) in params {
        s = s.replace(&format!("{{{name}}}"), value);
    }
    s
}

// ── Locale persistence & app state ───────────────────────────────────────────

/// Current UI locale, shared across commands and native UI.
pub struct AppLocale(pub Mutex<Locale>);

impl AppLocale {
    pub fn new(locale: Locale) -> Self {
        Self(Mutex::new(locale))
    }

    pub fn get(&self) -> Locale {
        *self.0.lock().unwrap()
    }

    pub fn set(&self, locale: Locale) {
        *self.0.lock().unwrap() = locale;
    }
}

pub fn locale_file_path(config_dir: &Path) -> PathBuf {
    config_dir.join(LOCALE_FILE)
}

pub fn read_stored_locale(config_dir: &Path) -> Option<Locale> {
    let content = std::fs::read_to_string(locale_file_path(config_dir)).ok()?;
    Locale::parse(content.trim())
}

pub fn write_stored_locale(config_dir: &Path, locale: Locale) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    std::fs::write(locale_file_path(config_dir), locale.as_str())
}

pub fn resolve_initial_locale(config_dir: Option<&Path>) -> Locale {
    if let Some(dir) = config_dir {
        if let Some(locale) = read_stored_locale(dir) {
            return locale;
        }
    }
    Locale::from_system()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_keys() -> &'static [Key] {
        use Key::*;
        &[
            MenuOpenDashboard,
            MenuConnections,
            MenuSyncNotion,
            MenuCheckUpdates,
            MenuLogout,
            SubmenuConnections,
            MenuFile,
            MenuEdit,
            MenuView,
            MenuWindow,
            MenuHelp,
            MenuSettings,
            WindowSettings,
            SettingsButtonLabel,
            SettingsButtonTooltip,
            ErrorBrainNeedsUpdateForSettings,
            TrayOpen,
            TrayQuit,
            CreditsCreatedBy,
            CreditsMaintainersLabel,
            OAuthSuccessTitle,
            OAuthSuccessBody,
            OAuthDeniedTitle,
            OAuthDeniedBody,
            LogoutTitle,
            LogoutMessage,
            LogoutConfirm,
            Cancel,
            NotionSyncTitle,
            AppUpdateUpToDateTitle,
            AppUpdateUpToDateMessage,
            AppUpdateCheckFailedTitle,
            AppUpdateCheckFailedMessage,
            AppUpdateAvailableTitle,
            AppUpdateAvailableMessage,
            AppUpdateWhatsNew,
            AppUpdateNow,
            AppUpdateLater,
            AppUpdateFailedTitle,
            AppUpdateFailedMessage,
            WorkerUpdateTitle,
            WorkerUpdateMessage,
            OpenDashboardFailed,
            OpenDashboardNotSetup,
            WindowSecondBrain,
            WindowConnections,
            ConnectionsButtonLabel,
            ConnectionsButtonTooltip,
            ErrorBadUrl,
            ErrorEmptyPassword,
            ErrorWrongPassword,
            ErrorNotABrain,
            ErrorCantReach,
            ErrorSetupNotFinished,
            ErrorPasswordTooShort,
            ErrorFriendlyRetry,
            ErrorSecureStoreSetup,
            ErrorSecureStoreConnect,
            ErrorUnknownTool,
            ErrorNoHomeFolder,
            ErrorMcpConfigFailed,
            ErrorCliConfigFailed,
            ErrorInstallInterrupted,
            ErrorClipboardFailed,
            ErrorOpenWindowFailed,
            ErrorCfNoAccount,
            ErrorCfSignInFirst,
            ErrorCfSignInExpired,
            ErrorBrainNeedsUpdateForMigration,
            ErrorUnknownEmbeddingModel,
            ErrorMigrationHalfSwitched,
            ErrorCannotDeleteLiveIndex,
            ErrorNoOldIndexToFree,
            ErrorCfNoSubdomain,
            ErrorCfDiscoverFailed,
            ErrorNotionSynced,
            ErrorNotionUpToDate,
            ErrorCfAccountListFailed,
            ErrorChoosePasswordFirst,
            ErrorLinkNotAllowed,
            ErrorOpenBrowserFailed,
            ErrorReachBrain,
            ErrorComputerNotSetup,
            ErrorCustomDomain,
            ErrorWrongCfAccount,
            ErrorBrainRefusedPassword,
            ErrorProvisioningDetail,
            ErrorBrainHttpStatus,
            ErrorBrainUnexpected,
            ErrorNotionSyncFailed,
            ErrorRotateBlocked,
            ErrorRotateNeedsHttps,
            ErrorRotateNotConfirmed,
            ErrorRotateSecureStore,
            ErrorNeedsHttps,
            GuardExistingBrain,
            GuardNameConflict,
            ErrorInvalidLocale,
        ]
    }

    #[test]
    fn parse_locale() {
        assert_eq!(Locale::parse("en"), Some(Locale::En));
        assert_eq!(Locale::parse("IT"), Some(Locale::It));
        assert_eq!(Locale::parse("fr"), None);
    }

    #[test]
    fn italian_menu_strings() {
        assert_eq!(t(Locale::It, Key::MenuOpenDashboard), "Apri dashboard");
        assert_eq!(t(Locale::It, Key::SubmenuConnections), "Connessioni");
    }

    #[test]
    fn t_fmt_replaces_placeholders() {
        let s = t_fmt(Locale::En, Key::ErrorPasswordTooShort, &[("min", "12")]);
        assert!(s.contains("12"));
        let s = t_fmt(Locale::It, Key::WorkerUpdateMessage, &[("version", "1.2.3")]);
        assert!(s.contains("1.2.3"));
    }

    #[test]
    fn locale_file_roundtrip() {
        let dir = std::env::temp_dir().join(format!("sb-locale-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_stored_locale(&dir, Locale::It).unwrap();
        assert_eq!(read_stored_locale(&dir), Some(Locale::It));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_initial_locale_prefers_stored_over_system() {
        let dir = std::env::temp_dir().join(format!("sb-locale-resolve-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_stored_locale(&dir, Locale::It).unwrap();
        assert_eq!(resolve_initial_locale(Some(&dir)), Locale::It);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_initial_locale_falls_back_without_stored_file() {
        let dir = std::env::temp_dir().join(format!("sb-locale-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // No locale file → same result as from_system().
        assert_eq!(resolve_initial_locale(Some(&dir)), Locale::from_system());
        assert_eq!(resolve_initial_locale(None), Locale::from_system());
    }

    #[test]
    fn every_key_has_non_empty_en_and_it_string() {
        for &key in all_keys() {
            let en = t(Locale::En, key);
            let it = t(Locale::It, key);
            assert!(!en.is_empty(), "empty EN string for {key:?}");
            assert!(!it.is_empty(), "empty IT string for {key:?}");
        }
    }
}
