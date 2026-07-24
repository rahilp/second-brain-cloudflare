/**
 * Second Brain — integration registry.
 *
 * Adding a provider: create src/integrations/<provider>.ts exporting an
 * IntegrationProvider (see framework.ts for the contract), and register it
 * here. The Worker's routes (/integrations/:provider/…), the nightly cron, the
 * mirror edit guard, and the settings UI all iterate this registry — no other
 * code changes needed.
 */

import type { IntegrationProvider } from "./framework";
import { notionProvider } from "./notion";
import { makeCalendarProvider } from "./calendar";
import { makeEmailProvider } from "./email";

export const calendarGoogle = makeCalendarProvider({
  id: "calendar-google",
  name: "Google Calendar",
  connectLabel: "Paste your Google Calendar secret iCal URL",
  connectPlaceholder: "https://calendar.google.com/calendar/ical/…/basic.ics",
  connectHint:
    'In Google Calendar (web): Settings → your calendar → <b>Integrate calendar</b> → copy the <b>"Secret address in iCal format"</b>. Keep it private — anyone with it can read the calendar.',
});

export const calendarOutlook = makeCalendarProvider({
  id: "calendar-outlook",
  name: "Outlook Calendar",
  connectLabel: "Paste your Outlook published ICS URL",
  connectPlaceholder: "https://outlook.live.com/owa/calendar/…/calendar.ics",
  connectHint:
    "In Outlook.com: Settings → Calendar → <b>Shared calendars</b> → Publish a calendar → publish, then copy the <b>ICS</b> link. (Work/school accounts may have publishing disabled.)",
});

export const calendarIcloud = makeCalendarProvider({
  id: "calendar-icloud",
  name: "iCloud Calendar",
  connectLabel: "Paste your iCloud shared calendar URL",
  connectPlaceholder: "webcal://p…-caldav.icloud.com/published/…",
  connectHint:
    "In Calendar (Mac or iCloud.com): right-click the calendar → <b>Share Calendar</b> → enable <b>Public Calendar</b> → copy the webcal link.",
});

export const emailGmail = makeEmailProvider({
  id: "email-gmail",
  name: "Gmail",
  host: "imap.gmail.com",
  connectLabel: "Connect your Gmail inbox",
  connectPlaceholder: "16-character app password",
  connectHint:
    "In your Google Account → Security → 2-Step Verification → <b>App passwords</b>, create one for Mail, then enter your Gmail address and that password. (Requires 2-Step Verification; IMAP must be enabled in Gmail settings.)",
});

export const emailIcloud = makeEmailProvider({
  id: "email-icloud",
  name: "iCloud Mail",
  host: "imap.mail.me.com",
  connectLabel: "Connect your iCloud inbox",
  connectPlaceholder: "app-specific password",
  connectHint:
    "At appleid.apple.com → Sign-In and Security → <b>App-Specific Passwords</b>, generate one, then enter your iCloud email and that password.",
});

export const INTEGRATION_PROVIDERS: Record<string, IntegrationProvider> = {
  [notionProvider.id]: notionProvider,
  [calendarGoogle.id]: calendarGoogle,
  [calendarOutlook.id]: calendarOutlook,
  [calendarIcloud.id]: calendarIcloud,
  [emailGmail.id]: emailGmail,
  [emailIcloud.id]: emailIcloud,
};

export function getProvider(id: string): IntegrationProvider | null {
  return Object.prototype.hasOwnProperty.call(INTEGRATION_PROVIDERS, id)
    ? INTEGRATION_PROVIDERS[id]
    : null;
}

export * from "./framework";
export {
  notionProvider,
  notionValidateToken,
  notionListPages,
  notionFetchPageText,
  extractPageTitle,
  flattenBlocks,
  buildPageContent,
  computeSyncPlan,
  SYNC_PAGE_BATCH,
} from "./notion";
export type { NotionPageMeta, SyncPlan } from "./notion";
export {
  makeCalendarProvider,
  parseAndExpand,
  buildEventContent,
  computeCalendarPlan,
  computeRetentionPrune,
  validateCalendarUrl,
} from "./calendar";
export type { Occurrence, CalendarService, CalendarMetaEntry, CalendarPlan } from "./calendar";
export {
  makeEmailProvider,
  parseEmailToken,
  isNoiseSender,
  looksBulk,
  computeEmailPlan,
  cleanEmailBody,
  buildEmailContent,
  validateEmailToken,
} from "./email";
export type { EmailService, EmailHeaderInfo, EmailCreds } from "./email";
export { ImapClient, parseHeaders, imapDate } from "./imap";
export type { FetchedMessage } from "./imap";
