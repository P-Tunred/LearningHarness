/**
 * Window opacity (fork addition): the appearance setting that lets the
 * desktop window's background turn see-through. Pure pieces only — the
 * native window material itself lives in electron/main.cjs.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appearanceVars, resolveAppearance, withOpacity } from "../components/settings/appearance.tsx";
import { parseAppearanceSettingsBody } from "../src/server/settings-body.ts";
import { FACTORY_SETTINGS, resolveSettings, sanitizeUserSettings } from "../src/core";

describe("withOpacity", () => {
	it("appends the alpha channel to 6- and 3-digit hex", () => {
		assert.equal(withOpacity("#141414", 100), "#141414ff");
		assert.equal(withOpacity("#141414", 0), "#14141400");
		assert.equal(withOpacity("#141414", 50), "#14141480");
		assert.equal(withOpacity("#abc", 100), "#aabbccff");
	});
});

describe("appearanceVars — window opacity", () => {
	it("factory is opaque: no background override, desktop or not", () => {
		assert.equal(FACTORY_SETTINGS.appearance.windowOpacity, 100);
		assert.equal(appearanceVars(resolveAppearance(undefined), true)["--background"], undefined);
	});

	it("desktop + lowered opacity: only --background turns translucent", () => {
		const vars = appearanceVars(resolveAppearance({ theme: "classic", windowOpacity: 50 }), true);
		assert.equal(vars["--background"], "#14141480", "default dark background at 50%");
		assert.equal(vars["--card"], undefined, "raised surfaces stay on the opaque stylesheet value");
	});

	it("a custom background keeps its derived opaque palette, base goes translucent", () => {
		const vars = appearanceVars(resolveAppearance({ theme: "classic", background: "#101820", windowOpacity: 60 }), true);
		assert.equal(vars["--background"], "#10182099");
		assert.equal(vars["--card"], "#182028");
		assert.equal(vars["--primary-foreground"], "#101820", "inverted text stays opaque");
	});

	it("plain browser: opacity is ignored (no desktop material behind the page)", () => {
		const vars = appearanceVars(resolveAppearance({ theme: "classic", windowOpacity: 50 }), false);
		assert.equal(vars["--background"], undefined);
	});
});

describe("windowOpacity persistence", () => {
	it("PUT accepts integers 30–100 and rejects the rest", () => {
		for (const ok of [30, 75, 100]) {
			const r = parseAppearanceSettingsBody({ windowOpacity: ok });
			assert.ok(r.ok && r.settings.windowOpacity === ok, String(ok));
		}
		for (const bad of [29, 101, 50.5, "80", null]) {
			assert.equal(parseAppearanceSettingsBody({ windowOpacity: bad }).ok, false, String(bad));
		}
	});

	it("disk sanitize clamps, resolution falls back to the factory", () => {
		const low = sanitizeUserSettings({ appearance: { windowOpacity: 5 } });
		assert.equal(low?.appearance?.windowOpacity, 30);
		const high = sanitizeUserSettings({ appearance: { windowOpacity: 250 } });
		assert.equal(high?.appearance?.windowOpacity, 100);
		const junk = sanitizeUserSettings({ appearance: { windowOpacity: "x" } });
		assert.equal(junk?.appearance?.windowOpacity, undefined);
		assert.equal(resolveSettings(null).appearance.windowOpacity, 100);
		assert.equal(resolveSettings({ version: 1, appearance: { windowOpacity: 70 } }).appearance.windowOpacity, 70);
	});
});

describe("Glas theme (Daily's look, Paul 2026-11-17)", () => {
	it("is the default; background and window opacity stay classic-only", async () => {
		const { themeAttributes } = await import("../components/settings/appearance.tsx");
		assert.equal(FACTORY_SETTINGS.appearance.theme, "glas");
		const glas = resolveAppearance({ background: "#101820", windowOpacity: 50 });
		const vars = appearanceVars(glas, true);
		assert.equal(vars["--background"], undefined, "no inline palette may override the glass");
		assert.equal(vars["--card"], undefined);
		assert.deepEqual(themeAttributes(glas, true), { theme: "glas", transparent: true });
		assert.deepEqual(themeAttributes(glas, false), { theme: "glas", transparent: false }, "a browser tab gets the dark ground, not the white page");
		assert.deepEqual(themeAttributes(resolveAppearance({ theme: "classic" }), true), { theme: "classic", transparent: false });
	});

	it("the theme is validated on save and on disk", () => {
		assert.equal(parseAppearanceSettingsBody({ theme: "classic" }).ok, true);
		assert.equal(parseAppearanceSettingsBody({ theme: "neon" }).ok, false);
		assert.equal(sanitizeUserSettings({ appearance: { theme: "classic" } })?.appearance?.theme, "classic");
		assert.equal(sanitizeUserSettings({ appearance: { theme: "neon" } })?.appearance?.theme, undefined);
		assert.equal(resolveSettings(null).appearance.theme, "glas");
	});
});
