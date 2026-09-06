//! Menu bar and system tray construction, with live locale updates.

use crate::i18n::{self, Key, Locale};
use tauri::menu::{
    AboutMetadata, Menu, MenuBuilder, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu,
    SubmenuBuilder,
};
use tauri::tray::TrayIconBuilder;
use tauri::AppHandle;

/// Handles to menu items so labels can be updated when the locale changes.
pub struct AppMenus {
    pub menu_open: MenuItem<tauri::Wry>,
    pub menu_hub: MenuItem<tauri::Wry>,
    pub menu_settings: MenuItem<tauri::Wry>,
    pub menu_sync: MenuItem<tauri::Wry>,
    pub menu_update: MenuItem<tauri::Wry>,
    pub menu_logout: MenuItem<tauri::Wry>,
    pub connections_submenu: Submenu<tauri::Wry>,
    pub tray_open: MenuItem<tauri::Wry>,
    pub tray_hub: MenuItem<tauri::Wry>,
    pub tray_settings: MenuItem<tauri::Wry>,
    pub tray_sync: MenuItem<tauri::Wry>,
    pub tray_update: MenuItem<tauri::Wry>,
    pub tray_logout: MenuItem<tauri::Wry>,
    pub tray_quit: MenuItem<tauri::Wry>,
}

impl AppMenus {
    pub fn apply_locale(&self, app: &AppHandle, locale: Locale) {
        let _ = self.menu_open.set_text(i18n::t(locale, Key::MenuOpenDashboard));
        let _ = self.menu_hub.set_text(i18n::t(locale, Key::MenuConnections));
        let _ = self.menu_settings.set_text(i18n::t(locale, Key::MenuSettings));
        let _ = self.menu_sync.set_text(i18n::t(locale, Key::MenuSyncNotion));
        let _ = self.menu_update.set_text(i18n::t(locale, Key::MenuCheckUpdates));
        let _ = self.menu_logout.set_text(i18n::t(locale, Key::MenuLogout));
        let _ = self
            .connections_submenu
            .set_text(i18n::t(locale, Key::SubmenuConnections));
        let _ = self.tray_open.set_text(i18n::t(locale, Key::TrayOpen));
        let _ = self.tray_hub.set_text(i18n::t(locale, Key::MenuConnections));
        let _ = self.tray_settings.set_text(i18n::t(locale, Key::MenuSettings));
        let _ = self.tray_sync.set_text(i18n::t(locale, Key::MenuSyncNotion));
        let _ = self.tray_update.set_text(i18n::t(locale, Key::MenuCheckUpdates));
        let _ = self.tray_logout.set_text(i18n::t(locale, Key::MenuLogout));
        let _ = self.tray_quit.set_text(i18n::t(locale, Key::TrayQuit));
        let _ = localize_os_menu_titles_from_app(app, locale);
        let _ = refresh_about_dialog(app, locale);
    }

    pub fn rebuild_tray_menu(&self, app: &AppHandle) -> tauri::Result<()> {
        let tray_menu = MenuBuilder::new(app)
            .items(&[&self.tray_open, &self.tray_hub, &self.tray_sync])
            .separator()
            .items(&[&self.tray_update, &self.tray_logout])
            .separator()
            .item(&self.tray_quit)
            .build()?;
        if let Some(tray) = app.tray_by_id("second-brain-tray") {
            tray.set_menu(Some(tray_menu))?;
        }
        Ok(())
    }
}

pub fn build_menu_items(
    app: &AppHandle,
    locale: Locale,
) -> tauri::Result<(
    MenuItem<tauri::Wry>,
    MenuItem<tauri::Wry>,
    MenuItem<tauri::Wry>,
    MenuItem<tauri::Wry>,
    MenuItem<tauri::Wry>,
    MenuItem<tauri::Wry>,
    Submenu<tauri::Wry>,
)> {
    let open_item = MenuItem::with_id(
        app,
        "menu-open",
        i18n::t(locale, Key::MenuOpenDashboard),
        true,
        Some("CmdOrCtrl+O"),
    )?;
    let hub_item = MenuItem::with_id(
        app,
        "menu-hub",
        i18n::t(locale, Key::MenuConnections),
        true,
        Some("CmdOrCtrl+D"),
    )?;
    let settings_item = MenuItem::with_id(
        app,
        "menu-settings",
        i18n::t(locale, Key::MenuSettings),
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let sync_item = MenuItem::with_id(
        app,
        "menu-sync-notion",
        i18n::t(locale, Key::MenuSyncNotion),
        true,
        None::<&str>,
    )?;
    let update_item = MenuItem::with_id(
        app,
        "menu-update",
        i18n::t(locale, Key::MenuCheckUpdates),
        true,
        None::<&str>,
    )?;
    let logout_item = MenuItem::with_id(
        app,
        "menu-logout",
        i18n::t(locale, Key::MenuLogout),
        true,
        None::<&str>,
    )?;
    let connections = SubmenuBuilder::new(app, i18n::t(locale, Key::SubmenuConnections))
        .item(&open_item)
        .item(&hub_item)
        .item(&settings_item)
        .item(&sync_item)
        .separator()
        .item(&update_item)
        .separator()
        .item(&logout_item)
        .build()?;
    Ok((
        open_item,
        hub_item,
        settings_item,
        sync_item,
        update_item,
        logout_item,
        connections,
    ))
}

/// Inserts the Connections submenu before Help and wires the native About dialog.
pub fn install_app_menu(
    app: &AppHandle,
    connections: &Submenu<tauri::Wry>,
    locale: Locale,
) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    let help_pos = find_help_submenu_index(&menu);
    if let Some(pos) = help_pos {
        menu.insert(connections, pos)?;
    } else {
        menu.append(connections)?;
    }

    localize_os_menu_titles(&menu, locale)?;
    wire_about_dialog(app, &menu, locale)?;
    app.set_menu(menu)?;
    Ok(())
}

fn find_help_submenu_index(menu: &Menu<tauri::Wry>) -> Option<usize> {
    let items = match menu.items() {
        Ok(items) => items,
        Err(_) => return None,
    };
    items.iter().position(|item| {
        matches!(item, MenuItemKind::Submenu(s) if is_help_submenu(s))
    })
}

fn is_help_submenu(submenu: &Submenu<tauri::Wry>) -> bool {
    matches!(
        submenu.text().ok().as_deref(),
        Some("Help") | Some("Aiuto")
    )
}

fn localize_os_menu_titles_from_app(app: &AppHandle, locale: Locale) -> tauri::Result<()> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    localize_os_menu_titles(&menu, locale)
}

fn localize_os_menu_titles(menu: &Menu<tauri::Wry>, locale: Locale) -> tauri::Result<()> {
    let pairs: [(Key, &[&str]); 5] = [
        (Key::MenuFile, &["File"]),
        (Key::MenuEdit, &["Edit", "Modifica"]),
        (Key::MenuView, &["View", "Visualizza"]),
        (Key::MenuWindow, &["Window", "Finestra"]),
        (Key::MenuHelp, &["Help", "Aiuto"]),
    ];
    for item in menu.items()? {
        if let MenuItemKind::Submenu(sub) = item {
            let text = sub.text().ok();
            for (key, labels) in pairs {
                if labels.iter().any(|label| text.as_deref() == Some(*label)) {
                    let _ = sub.set_text(i18n::t(locale, key));
                }
            }
        }
    }
    Ok(())
}

fn about_metadata(app: &AppHandle, locale: Locale) -> AboutMetadata<'_> {
    let version = app.package_info().version.to_string();
    AboutMetadata {
        name: Some(app.package_info().name.clone()),
        version: Some(version),
        credits: Some(crate::credits::credits_text(locale)),
        authors: Some(crate::credits::author_names()),
        copyright: Some(format!("© {}", crate::credits::CREATOR.name)),
        license: Some("MIT".into()),
        website: Some("https://github.com/rahilp/second-brain-cloudflare".into()),
        website_label: Some("GitHub".into()),
        ..Default::default()
    }
}

/// Gives the native About panel our metadata.
///
/// `Menu::default` builds its own About item with no metadata, and merely
/// *instantiating* a configured `PredefinedMenuItem::about` does not reconfigure
/// it — the metadata belongs to the item, not to the application. So the panel
/// only shows credits if the item we built is the one the user actually clicks.
///
/// The previous version created the configured item and then dropped it unless
/// no Help submenu existed. macOS always has Help, so on macOS the credits were
/// never reachable: the panel fell back to the name and version macOS derives
/// from the bundle.
fn wire_about_dialog(
    app: &AppHandle,
    menu: &Menu<tauri::Wry>,
    locale: Locale,
) -> tauri::Result<()> {
    let about = PredefinedMenuItem::about(app, None, Some(about_metadata(app, locale)))?;

    // macOS: the first submenu is the application menu and its first entry is
    // About. Swap that entry for ours rather than rebuilding the whole submenu,
    // which would risk dropping Services / Hide Others / Show All.
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        let existing = app_menu.items()?;
        // Only replace when the menu has the shape we expect; a surprise layout
        // should leave the menu intact rather than be mangled.
        if let Some(MenuItemKind::Predefined(first)) = existing.first() {
            app_menu.remove(first)?;
            app_menu.insert(&about, 0)?;
            return Ok(());
        }
    }

    // Windows / Linux: no application menu, so surface it under Help.
    if find_help_submenu_index(menu).is_none() {
        let help = SubmenuBuilder::new(app, i18n::t(locale, Key::MenuHelp))
            .item(&about)
            .build()?;
        menu.append(&help)?;
    }
    Ok(())
}

fn refresh_about_dialog(app: &AppHandle, locale: Locale) -> tauri::Result<()> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    wire_about_dialog(app, &menu, locale)?;
    Ok(())
}

pub fn build_tray_items(
    app: &AppHandle,
    locale: Locale,
) -> tauri::Result<(
    MenuItem<tauri::Wry>,
    MenuItem<tauri::Wry>,
    MenuItem<tauri::Wry>,
    MenuItem<tauri::Wry>,
    MenuItem<tauri::Wry>,
    MenuItem<tauri::Wry>,
    MenuItem<tauri::Wry>,
    Menu<tauri::Wry>,
)> {
    let tray_open = MenuItem::with_id(
        app,
        "tray-open",
        i18n::t(locale, Key::TrayOpen),
        true,
        None::<&str>,
    )?;
    let tray_hub = MenuItem::with_id(
        app,
        "tray-hub",
        i18n::t(locale, Key::MenuConnections),
        true,
        None::<&str>,
    )?;
    let tray_settings = MenuItem::with_id(
        app,
        "tray-settings",
        i18n::t(locale, Key::MenuSettings),
        true,
        None::<&str>,
    )?;
    let tray_sync = MenuItem::with_id(
        app,
        "tray-sync-notion",
        i18n::t(locale, Key::MenuSyncNotion),
        true,
        None::<&str>,
    )?;
    let tray_update = MenuItem::with_id(
        app,
        "tray-update",
        i18n::t(locale, Key::MenuCheckUpdates),
        true,
        None::<&str>,
    )?;
    let tray_logout = MenuItem::with_id(
        app,
        "tray-logout",
        i18n::t(locale, Key::MenuLogout),
        true,
        None::<&str>,
    )?;
    let tray_quit = MenuItem::with_id(
        app,
        "tray-quit",
        i18n::t(locale, Key::TrayQuit),
        true,
        None::<&str>,
    )?;
    let tray_menu = MenuBuilder::new(app)
        .items(&[&tray_open, &tray_hub, &tray_sync])
        .separator()
        .items(&[&tray_update, &tray_logout])
        .separator()
        .item(&tray_quit)
        .build()?;
    Ok((
        tray_open,
        tray_hub,
        tray_settings,
        tray_sync,
        tray_update,
        tray_logout,
        tray_quit,
        tray_menu,
    ))
}

pub fn install_tray<F>(
    app: &AppHandle,
    tray_menu: &Menu<tauri::Wry>,
    on_menu_event: F,
) -> tauri::Result<()>
where
    F: Fn(&AppHandle, tauri::menu::MenuEvent) + Send + Sync + 'static,
{
    TrayIconBuilder::with_id("second-brain-tray")
        .icon(
            app.default_window_icon()
                .expect("bundled icon")
                .clone(),
        )
        .menu(tray_menu)
        .show_menu_on_left_click(true)
        .on_menu_event(on_menu_event)
        .build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    /// The configured About item must be *attached* to a menu, not merely
    /// created.
    ///
    /// #241 built it and then dropped it unless no Help submenu existed. macOS
    /// always has Help, so the credits were unreachable there: the panel showed
    /// only the name and version macOS derives from the bundle. Attaching the
    /// item cannot be asserted without a running app, so this asserts on the
    /// source instead — the specific mistake was a discard, and a discard is
    /// visible in the text.
    #[test]
    fn the_configured_about_item_is_never_discarded() {
        let src = include_str!("app_menus.rs");
        let start = src.find("fn wire_about_dialog").expect("wire_about_dialog");
        let end = src[start..].find("\n}\n").expect("end of fn") + start;
        let body = &src[start..end];

        assert!(
            !body.contains("let _ = about"),
            "the configured About item is being discarded — on macOS that leaves the panel with no credits"
        );
        assert!(
            body.contains("insert(&about"),
            "the configured About item must be inserted into the app menu, not just created"
        );
    }

    /// Tauri's default macOS menu adds a View submenu that File/Edit/Window/Help
    /// renaming used to miss. Deleting the `MenuView` row from `pairs` used to
    /// leave every Rust test green. Asserted on the source because the submenu
    /// only exists in a real macOS build.
    #[test]
    fn os_menu_rename_table_covers_every_menu_key() {
        let src = include_str!("app_menus.rs");
        let start = src
            .find("fn localize_os_menu_titles(")
            .expect("localize_os_menu_titles");
        let end = src[start..].find("\n}\n").expect("end of fn") + start;
        let body = &src[start..end];

        for key in ["MenuFile", "MenuEdit", "MenuView", "MenuWindow", "MenuHelp"] {
            assert!(
                body.contains(&format!("Key::{key}")),
                "localize_os_menu_titles pairs table no longer covers Key::{key} — \
                 deleting that row used to leave the macOS menubar half-English"
            );
        }
    }

    /// The metadata is worthless if the roster is empty.
    #[test]
    fn about_metadata_carries_the_full_roster() {
        let credits = crate::credits::credits_text(crate::i18n::Locale::En);
        assert!(credits.contains("Created by"), "credits text has no creator line");
        for person in crate::credits::MAINTAINERS {
            assert!(
                credits.contains(person.name),
                "credits text omits maintainer {}",
                person.name
            );
        }
    }
}
