# Ratchet learnings

Every Ratchet agent reads this file before starting work. Entries come from human reviews and repeated gate failures.

- (2026-10-13, gate:adversarial) A test of a fallback path must prove the injected result was actually consumed (e.g. no fallback warning, or the stub returned), because a crash in the same try block takes the same fallback and passes silently.
