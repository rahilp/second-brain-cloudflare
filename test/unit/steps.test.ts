/**
 * The setup rail's model (`installer/src/steps.ts`).
 *
 * Same arrangement as `test/unit/ridge.test.ts`: `main.ts` resolves `#app` at
 * module scope and cannot be imported outside a webview, so the part of the
 * rail that is a decision rather than a render — which step a screen belongs
 * to, which walk it is on, and which of the steps behind it can still be
 * clicked — lives in its own module of plain functions over plain data.
 *
 * The two things worth guarding here are the two that would be silent in a
 * screenshot: a screen that maps to no step (the rail would vanish mid-flow)
 * and a back-jump that is offered past the point where this app has an undo.
 */
import { describe, it, expect } from "vitest";
import {
  SPINES,
  SCREEN_STEPS,
  STEP_LABEL_KEYS,
  POINT_OF_NO_RETURN,
  railFor,
  allowedBackSteps,
  canJumpBack,
  type PathId,
  type ScreenName,
  type StepId,
} from "../../installer/src/steps";
import { en } from "../../installer/src/i18n/en";
import { it as itCatalog } from "../../installer/src/i18n/it";

/** The step a screen resolves to on a path, or null when it draws no rail. */
function stepOf(screen: ScreenName, path: PathId): StepId | null {
  return railFor(screen, path)?.current ?? null;
}

describe("the three spines", () => {
  it("all start at Start and end at Details", () => {
    for (const path of Object.keys(SPINES) as PathId[]) {
      expect(SPINES[path][0], path).toBe("start");
      expect(SPINES[path].at(-1), path).toBe("details");
    }
  });

  it("puts Tools before Details, the order main.ts actually walks", () => {
    // progressScreen and existingTeamScreen both hand off to toolsScreen, whose
    // only forward control is "Continue to connection details".
    for (const path of Object.keys(SPINES) as PathId[]) {
      const spine = SPINES[path];
      expect(spine.indexOf("tools"), path).toBeLessThan(spine.indexOf("details"));
    }
  });

  it("only builds on the new-brain path", () => {
    expect(SPINES.new).toContain("build");
    expect(SPINES.existing).not.toContain("build");
    expect(SPINES.token).not.toContain("build");
  });

  it("drops sign-in and the scan from the member/token walk", () => {
    expect(SPINES.token).toEqual(["start", "connect", "tools", "details"]);
  });

  it("never repeats a step", () => {
    for (const path of Object.keys(SPINES) as PathId[]) {
      expect(new Set(SPINES[path]).size, path).toBe(SPINES[path].length);
    }
  });
});

describe("every screen's step", () => {
  const newPath: [ScreenName, StepId][] = [
    ["welcome", "start"],
    ["audience", "start"],
    ["password", "protect"],
    ["cloudflare", "connect"],
    ["cloudflareWaiting", "connect"],
    ["accountPickerProvision", "connect"],
    ["progress", "build"],
    ["progressFailed", "build"],
    ["existingBrainGuard", "build"],
    ["resourceConflictGuard", "build"],
    ["tools", "tools"],
    ["details", "details"],
  ];
  it.each(newPath)("maps %s to %s on the new-brain path", (screen, step) => {
    expect(stepOf(screen, "new")).toBe(step);
  });

  const existingPath: [ScreenName, StepId][] = [
    ["welcome", "start"],
    ["connectExisting", "signIn"],
    ["searching", "find"],
    ["accountPickerDiscover", "find"],
    ["brainPicker", "find"],
    ["unlockBrain", "connect"],
    ["manualEntry", "connect"],
    ["memberTokenHelp", "connect"],
    ["existingTeam", "connect"],
    ["tools", "tools"],
    ["details", "details"],
  ];
  it.each(existingPath)("maps %s to %s on the connect-existing path", (screen, step) => {
    expect(stepOf(screen, "existing")).toBe(step);
  });

  const tokenPath: [ScreenName, StepId][] = [
    ["welcome", "start"],
    ["manualEntry", "connect"],
    ["memberTokenHelp", "connect"],
    ["existingTeam", "connect"],
    ["tools", "tools"],
    ["details", "details"],
  ];
  it.each(tokenPath)("maps %s to %s on the member/token path", (screen, step) => {
    expect(stepOf(screen, "token")).toBe(step);
  });

  it("gives every screen name an entry, so none can fall through silently", () => {
    for (const [screen, mapping] of Object.entries(SCREEN_STEPS)) {
      expect(mapping === null || typeof mapping.step === "string", screen).toBe(true);
    }
  });

  it("never lands a screen on a step its own path does not have", () => {
    // The token walk has no Sign in and no Find; the connect-existing walk has
    // no Build. A screen resolving to a step off its spine would be a rail with
    // no current position, which `railFor` refuses to draw at all.
    expect(railFor("searching", "token")).toBeNull();
    expect(railFor("connectExisting", "token")).toBeNull();
    expect(railFor("progress", "existing")).toBeNull();
  });
});

describe("screens that pause the rail rather than advancing it", () => {
  const paused: [ScreenName, PathId][] = [
    ["searching", "existing"],
    ["cloudflareWaiting", "new"],
    ["existingBrainGuard", "new"],
    ["resourceConflictGuard", "new"],
    ["progressFailed", "new"],
    ["memberTokenHelp", "existing"],
  ];
  it.each(paused)("marks %s paused", (screen, path) => {
    expect(railFor(screen, path)?.paused).toBe(true);
  });

  it("keeps a guard on its parent step instead of adding one", () => {
    // Both provisioning guards interrupt Build, and neither is a seventh step.
    expect(railFor("existingBrainGuard", "new")?.index).toBe(
      railFor("progress", "new")?.index,
    );
    expect(railFor("existingBrainGuard", "new")?.total).toBe(SPINES.new.length);
  });

  it("spins only while provisioning is actually running", () => {
    expect(railFor("progress", "new")?.running).toBe(true);
    expect(railFor("progressFailed", "new")?.running).toBe(false);
  });
});

describe("the flows with no rail at all", () => {
  // Management, not onboarding: none of them starts at the welcome screen or
  // ends at the tools list, so a six-step rail would tick off steps that never
  // ran on this machine.
  const railless: ScreenName[] = ["rotation", "workerUpdate", "stalePassword"];
  it.each(railless)("draws nothing on %s, on every path", (screen) => {
    for (const path of Object.keys(SPINES) as PathId[]) {
      expect(railFor(screen, path), path).toBeNull();
    }
  });

  it("offers no back-jump from a screen with no rail", () => {
    expect(allowedBackSteps("rotation", "new")).toEqual([]);
    expect(allowedBackSteps("workerUpdate", "new")).toEqual([]);
  });
});

describe("the step marks", () => {
  it("marks everything before the current step done and everything after todo", () => {
    const model = railFor("progress", "new")!;
    expect(model.steps.map((s) => s.state)).toEqual([
      "done",
      "done",
      "done",
      "current",
      "todo",
      "todo",
    ]);
    expect(model.index).toBe(4);
    expect(model.total).toBe(6);
  });

  it("numbers from one", () => {
    expect(railFor("welcome", "new")!.steps.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("back-jumps before the Build boundary", () => {
  it("lets the password screen go back to the start", () => {
    expect(allowedBackSteps("password", "new")).toEqual(["start"]);
  });

  it("lets the Cloudflare screen go back to the password, before it signs in", () => {
    expect(allowedBackSteps("cloudflare", "new", { signedIn: false })).toEqual([
      "start",
      "protect",
    ]);
  });

  it("closes the password step once Cloudflare has been signed in to", () => {
    // No single Back button makes that jump: the way back from the account
    // picker is the sign-in screen, and only from there the password screen.
    expect(allowedBackSteps("accountPickerProvision", "new", { signedIn: true })).toEqual([
      "start",
    ]);
    expect(canJumpBack("accountPickerProvision", "new", "protect", { signedIn: true })).toBe(
      false,
    );
  });

  it("lets the unlock screen go back to the picker it came from", () => {
    expect(allowedBackSteps("unlockBrain", "existing", { hasFound: true })).toEqual([
      "start",
      "signIn",
      "find",
    ]);
  });

  it("does not offer Find with no scan result held", () => {
    expect(allowedBackSteps("unlockBrain", "existing", { hasFound: false })).toEqual([
      "start",
      "signIn",
    ]);
  });

  it("offers only the start on the member/token walk", () => {
    // Its spine is Start, Connect, Tools, Details: nothing between the front
    // door and the address field, and Connect is never a back target.
    expect(allowedBackSteps("manualEntry", "token", { hasFound: true })).toEqual(["start"]);
  });

  it("never offers the step the user is already on, or one ahead of it", () => {
    for (const path of Object.keys(SPINES) as PathId[]) {
      for (const screen of Object.keys(SCREEN_STEPS) as ScreenName[]) {
        const model = railFor(screen, path);
        if (!model) continue;
        const allowed = allowedBackSteps(screen, path, { hasFound: true });
        for (const id of allowed) {
          expect(SPINES[path].indexOf(id), `${path}/${screen}/${id}`).toBeLessThan(model.index - 1);
        }
      }
    }
  });
});

describe("the Build boundary", () => {
  it("refuses every jump from provisioning and everything after it", () => {
    for (const screen of ["progress", "progressFailed", "tools", "details"] as ScreenName[]) {
      expect(allowedBackSteps(screen, "new", { hasFound: true }), screen).toEqual([]);
    }
  });

  it("refuses every jump from the two provisioning guards", () => {
    expect(allowedBackSteps("existingBrainGuard", "new")).toEqual([]);
    expect(allowedBackSteps("resourceConflictGuard", "new")).toEqual([]);
  });

  it("refuses jumps after a connection is stored, on the paths with no Build", () => {
    // `connect_existing` wrote to the keychain; the same rule applies without a
    // Build step to draw the line at.
    for (const path of ["existing", "token"] as PathId[]) {
      expect(allowedBackSteps("tools", path, { hasFound: true }), path).toEqual([]);
      expect(allowedBackSteps("details", path, { hasFound: true }), path).toEqual([]);
    }
  });

  it("states the boundary as the last three steps of every spine", () => {
    expect([...POINT_OF_NO_RETURN]).toEqual(["build", "tools", "details"]);
  });

  it("offers nothing while a request is in flight", () => {
    expect(allowedBackSteps("unlockBrain", "existing", { hasFound: true, busy: true })).toEqual(
      [],
    );
    expect(allowedBackSteps("password", "new", { busy: true })).toEqual([]);
  });

  it("offers nothing while a guard or a scan is up", () => {
    expect(allowedBackSteps("searching", "existing", { hasFound: true })).toEqual([]);
    expect(allowedBackSteps("cloudflareWaiting", "new")).toEqual([]);
    expect(allowedBackSteps("memberTokenHelp", "existing")).toEqual([]);
  });

  it("never offers Connect or Build as a destination from anywhere", () => {
    // Neither has a screen function safe to re-enter from further along:
    // Connect is a sign-in on one path and a stored credential on another.
    for (const path of Object.keys(SPINES) as PathId[]) {
      for (const screen of Object.keys(SCREEN_STEPS) as ScreenName[]) {
        const allowed = allowedBackSteps(screen, path, { hasFound: true, signedIn: false });
        expect(allowed, `${path}/${screen}`).not.toContain("connect");
        expect(allowed, `${path}/${screen}`).not.toContain("build");
      }
    }
  });
});

describe("the rail's copy", () => {
  it("has an English and an Italian label for every step", () => {
    for (const [step, key] of Object.entries(STEP_LABEL_KEYS)) {
      const leaf = key.split(".")[1];
      expect(en.steps[leaf as keyof typeof en.steps], `en ${step}`).toBeTruthy();
      expect(itCatalog.steps[leaf as keyof typeof itCatalog.steps], `it ${step}`).toBeTruthy();
    }
  });

  it("keeps every label short enough for a 208px rail", () => {
    for (const key of Object.keys(STEP_LABEL_KEYS) as StepId[]) {
      expect(en.steps[key].length, `en ${key}`).toBeLessThanOrEqual(16);
      expect(itCatalog.steps[key].length, `it ${key}`).toBeLessThanOrEqual(16);
    }
  });

  it("keeps the placeholders the rail actually substitutes", () => {
    for (const catalog of [en, itCatalog]) {
      expect(catalog.steps.backTo).toContain("{step}");
      expect(catalog.steps.compact).toContain("{n}");
      expect(catalog.steps.compact).toContain("{total}");
    }
  });
});
