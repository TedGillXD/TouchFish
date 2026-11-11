import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { resolve } from "node:path";

await mkdir(".cache", { recursive: true });
const userData = await mkdtemp(resolve(".cache/payroll-smoke-"));
const env = {
  ...process.env,
  TOUCHFISH_USER_DATA: userData,
  TOUCHFISH_KEEP_OPEN: "1",
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
const errors = [];
try {
  app = await electron.launch({
    executablePath: process.env.TOUCHFISH_EXECUTABLE || electronPath,
    args: process.env.TOUCHFISH_EXECUTABLE ? [] : ["."],
    env,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-09-15T10:00:00") });
  await page.clock.pauseAt(new Date("2026-09-15T10:01:00"));
  await expect(page.getByText("今日已赚", { exact: true })).toBeVisible();
  // A shortcut to an upcoming payout opens that payout's earning period.
  await expect(page.locator(".payday-shortcut")).toContainText("9月15日");
  await page.locator(".payday-shortcut").click();
  await expect(page.locator(".payroll-range")).toHaveText(
    "2026.08.01 — 2026.08.31",
  );
  await expect(page.locator(".payday-actual")).toHaveText("2026.09.15");
  await page.getByRole("button", { name: "返回", exact: true }).click();

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByLabel("每月计薪起始日")).toHaveValue("1");
  await expect(page.getByLabel("每月发薪日")).toHaveValue("15");
  await expect(
    page.getByRole("button", { name: "提前到最近工作日", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("每月计薪起始日").selectOption("26");
  await page.getByLabel("发薪月份").selectOption("0");
  await page.getByLabel("每月发薪日").selectOption("3");
  await expect(page.locator(".payroll-preview")).toContainText(
    "2026.08.26 — 2026.09.25",
  );
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(resolve(userData, "state.json"), "utf8"))
          .settings.payroll,
    )
    .toEqual({
      cycleStartDay: 26,
      payDay: 3,
      payMonthOffset: 0,
      holidayAdjustment: "previous",
    });
  await expect(page.locator(".payday-shortcut")).toContainText("9月30日");
  expect(
    await page
      .locator(".main-content")
      .evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
  ).toBe(true);

  await page.getByRole("button", { name: "薪资周期", exact: true }).click();
  await expect(page.locator(".payroll-range")).toHaveText(
    "2026.08.26 — 2026.09.25",
  );
  await page.getByRole("button", { name: "下个周期", exact: true }).click();
  await expect(page.locator(".payroll-range")).toHaveText(
    "2026.09.26 — 2026.10.25",
  );
  await expect(page.locator(".payday-nominal")).toHaveText("2026.10.03");
  await expect(page.locator(".payday-actual")).toHaveText("2026.09.30");
  await expect(page.locator(".payday-card")).toContainText("提前 3 天");
  await page.clock.fastForward(3000);
  await page.locator(".main-content").evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({ path: ".cache/payroll-previous.png", scale: "css" });

  await page.getByRole("button", { name: "修改薪资设置", exact: true }).click();
  await page
    .getByRole("button", { name: "顺延到最近工作日", exact: true })
    .click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.locator(".payday-shortcut")).toContainText("10月8日");
  await page.locator(".payday-shortcut").click();
  await expect(page.locator(".payroll-range")).toHaveText(
    "2026.09.26 — 2026.10.25",
  );
  await expect(page.locator(".payday-actual")).toHaveText("2026.10.08");
  await expect(page.locator(".payday-card")).toContainText("顺延 5 天");
  await page.getByRole("button", { name: "上个周期", exact: true }).click();
  await expect(page.locator(".payroll-range")).toHaveText(
    "2026.08.26 — 2026.09.25",
  );
  await page.getByRole("button", { name: "返回", exact: true }).click();

  await page.getByRole("button", { name: /开始工作/ }).click();
  await page.clock.runFor(61000);
  await expect(page.locator(".mono")).toHaveText("00:01:01");
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(resolve(userData, "state.json"), "utf8"))
          .records["2026-09-15"].plan.periodStart,
    )
    .toBe("2026-08-26");
  const record = JSON.parse(
    await readFile(resolve(userData, "state.json"), "utf8"),
  ).records["2026-09-15"];
  expect(record.plan.periodEnd).toBe("2026-09-25");
  expect(record.plan.dailyWage).toBe(15000 / record.plan.workdays);
  await page.getByRole("button", { name: "暂停计时", exact: true }).click();
  await page.getByRole("button", { name: /周期已记录/ }).click();
  await expect(page.locator(".history-total")).toContainText(
    "2026.08.26 — 2026.09.25",
  );
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.screenshot({ path: ".cache/payroll-dashboard.png", scale: "css" });
  await page.reload();
  await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByLabel("每月计薪起始日")).toHaveValue("26");
  await expect(page.getByLabel("发薪月份")).toHaveValue("0");
  await expect(page.getByLabel("每月发薪日")).toHaveValue("3");
  await expect(
    page.getByRole("button", { name: "顺延到最近工作日", exact: true }),
  ).toHaveClass("active");
  await page.locator(".payroll-settings").scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".cache/payroll-settings.png", scale: "css" });
  expect(errors).toEqual([]);
  console.log(
    "PASS: custom monthly cycle, salary denominator, nearest payday before/after National Day, correct next-payout shortcut, cycle navigation/history, settings and record persistence.",
  );
} finally {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
}
