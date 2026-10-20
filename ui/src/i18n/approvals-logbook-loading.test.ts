/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it.each([
  {
    surface: "approval card",
    probe: "approvalPage.actionsLabel",
    load: () => import("../components/exec-approval-card.ts"),
    catalog: async () => (await import("./locales/en-approvals.ts")).registerApprovalsEnglish,
  },
  {
    surface: "approval presentation",
    probe: "approvalPage.approved",
    load: () => import("../pages/approval/approval-presentation.ts"),
    catalog: async () => (await import("./locales/en-approvals.ts")).registerApprovalsEnglish,
  },
  {
    surface: "approval history",
    probe: "standingGrants.title",
    load: () => import("../pages/approvals/approvals-page.ts"),
    catalog: async () => (await import("./locales/en-approvals.ts")).registerApprovalsEnglish,
  },
  {
    surface: "logbook controller",
    probe: "logbook.status.paused",
    load: () => import("../pages/plugin/logbook-controller.ts"),
    catalog: async () => (await import("./locales/en-logbook.ts")).registerLogbookEnglish,
  },
  {
    surface: "logbook view",
    probe: "logbook.nav.today",
    load: () => import("../pages/plugin/logbook-view.ts"),
    catalog: async () => (await import("./locales/en-logbook.ts")).registerLogbookEnglish,
  },
])(
  "loads deferred English fallback copy at the $surface boundary",
  async ({ probe, load, catalog }) => {
    const { manager } = await loadI18n();
    expect(manager.t(probe)).toBe(probe);
    await manager.setLocale("de");
    await load();
    for (const [key, value] of flattenTranslations((await catalog()).catalog)) {
      expect(manager.t(key)).toBe(value);
    }
    expect(manager.t("common.health")).toBe("Gesundheit");
  },
);
