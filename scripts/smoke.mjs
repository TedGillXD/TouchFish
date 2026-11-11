import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Runs the real desktop shell against a fresh, isolated user-data directory.
await mkdir(".cache", { recursive: true });
const userData = await mkdtemp(resolve(".cache/smoke-"));
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
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-11-10T10:00:00") });
  await page.clock.pauseAt(new Date("2026-11-10T10:01:00"));
  await expect(page.getByText("今日已赚", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /开始工作/ })).toBeVisible();
  await page.screenshot({ path: ".cache/dashboard-initial.png", scale: "css" });

  await page.getByRole("button", { name: "设置", exact: true }).click();
  console.log("Checking settings and meal configuration...");
  await page.getByRole("spinbutton", { name: "税前月薪" }).fill("22000");
  await page.getByRole("button", { name: "单休", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "排除公共假期" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.getByLabel("周二下班时间").fill("21:00");
  await expect(page.getByLabel("晚饭开始")).toHaveValue("18:00");
  await expect(page.getByLabel("晚饭结束")).toHaveValue("19:00");
  await page.getByLabel("晚饭开始").fill("18:15");
  await page.getByLabel("晚饭结束").fill("19:15");
  await page.getByRole("switch", { name: "扣除晚饭" }).click();
  await expect(page.getByLabel("晚饭开始")).toHaveCount(0);
  await page.getByRole("switch", { name: "扣除晚饭" }).click();
  await page.screenshot({ path: ".cache/dinner-settings.png", scale: "css" });
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.locator(".payday-shortcut")).toContainText("下次发薪");
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(resolve(userData, "state.json"), "utf8"))
          .settings.scheduleMode,
    )
    .toBe("single");
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(resolve(userData, "state.json"), "utf8"))
          .settings.dinner,
    )
    .toEqual({ enabled: true, start: "18:15", end: "19:15" });

  await page.getByRole("button", { name: /开始工作/ }).click();
  await page.clock.runFor(61000);
  await expect(page.getByText("00:01:01", { exact: true })).toBeVisible();
  await expect(page.getByText("正在工作", { exact: true })).toBeVisible();
  expect(
    await page
      .locator(".main-content")
      .evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
  ).toBe(true);
  await page.screenshot({ path: ".cache/dashboard-working.png", scale: "css" });
  await page.getByRole("button", { name: "暂停计时" }).click();
  await page.clock.runFor(15000);
  await expect(page.getByText("00:01:01", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /继续工作/ }).click();
  await page.clock.runFor(9000);
  await expect(page.getByText("00:01:10", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "隐藏金额" }).click();
  await expect(page.locator(".earnings")).toContainText("••••");
  await page.getByRole("button", { name: "显示金额" }).click();
  await page
    .getByRole("button", { name: /工作日历/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "工作日历" })).toBeVisible();
  await page.getByRole("button", { name: "2026-11-15 休息日" }).click();
  await page.getByRole("button", { name: "设为工作", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "2026-11-15 工作日" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "下个月" }).click();
  await expect(page.locator(".override-panel h3")).toContainText("2026.12.01");
  await page.screenshot({ path: ".cache/calendar.png", scale: "css" });
  await page.getByRole("button", { name: "上个月" }).click();
  await page.getByRole("button", { name: "上个月" }).click();
  await expect(page.locator(".calendar-summary strong").first()).toHaveText(
    "21",
  );
  await page
    .getByRole("button", { name: "2026-10-01 休息日", exact: true })
    .click();
  await expect(page.locator(".holiday-day-note")).toContainText("国庆节");
  await expect(
    page.getByRole("button", { name: "2026-10-01 休息日", exact: true }),
  ).toContainText("假");
  await expect(
    page.getByRole("button", { name: "2026-10-10 工作日", exact: true }),
  ).toContainText("班");
  await page.getByRole("button", { name: "设为工作", exact: true }).click();
  await expect(page.locator(".calendar-summary strong").first()).toHaveText(
    "22",
  );
  await page.getByRole("button", { name: "跟随安排", exact: true }).click();
  await expect(page.locator(".calendar-summary strong").first()).toHaveText(
    "21",
  );
  await page.screenshot({ path: ".cache/holiday-calendar.png", scale: "css" });
  await page.getByRole("button", { name: "返回", exact: true }).click();

  await page.getByRole("button", { name: "设置", exact: true }).click();
  console.log("Checking snapshot-safe settings update...");
  await page.getByRole("button", { name: "大小周", exact: true }).click();
  await page.locator("input[type=date]").fill("2026-11-09");
  await page.getByLabel("周三下班时间").fill("17:30");
  await expect(page.getByLabel("周三下班时间")).toHaveValue("17:30");
  await page.screenshot({ path: ".cache/settings.png", scale: "css" });
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByRole("heading", { name: "偏好设置" })).toHaveCount(0);
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(resolve(userData, "state.json"), "utf8"))
          .settings.weekdayHours[3].end,
    )
    .toBe("17:30");

  const beforeDinner = new Date("2026-11-10T18:14:59").getTime();
  console.log("Checking actual dinner break and resumed accrual...");
  await page.clock.fastForward(
    beforeDinner - (await page.evaluate(() => Date.now())),
  );
  await expect(page.getByText("正在工作", { exact: true })).toBeVisible();
  await page.clock.runFor(1000);
  await expect(page.getByText("晚饭中", { exact: true })).toBeVisible();
  const mealSeconds = await page.locator(".mono").innerText();
  const mealEarnings = await page.locator(".earnings").textContent();
  await page.clock.fastForward(30 * 60 * 1000);
  await expect(page.locator(".mono")).toHaveText(mealSeconds);
  await expect(page.locator(".earnings")).toHaveText(mealEarnings);
  await page.screenshot({ path: ".cache/dinner-break.png", scale: "css" });
  await page.clock.fastForward(30 * 60 * 1000 + 5000);
  await expect(page.getByText("正在工作", { exact: true })).toBeVisible();
  const totalSeconds = (text) =>
    text.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  expect(
    totalSeconds(await page.locator(".mono").innerText()) -
      totalSeconds(mealSeconds),
  ).toBe(5);

  await page.getByRole("button", { name: "下班", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "确认下班" }).click();
  await expect(page.getByText("今天辛苦了，好好休息")).toBeVisible();
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(resolve(userData, "state.json"), "utf8"))
          .records["2026-11-10"].completed,
    )
    .toBe(true);
  await page.getByRole("button", { name: /周期已记录/ }).click();
  await expect(page.getByRole("heading", { name: "工作记录" })).toBeVisible();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.getByRole("button", { name: "返回", exact: true }).click();

  await page.getByRole("button", { name: "收起到托盘" }).click();
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find((win) => !win.webContents.getURL().includes("window=floating")).isVisible(),
      ),
    )
    .toBe(false);
  await app.evaluate(({ app }) => app.emit("second-instance", {}, [], ""));
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find((win) => !win.webContents.getURL().includes("window=floating")).isVisible(),
      ),
    )
    .toBe(true);
  await page.reload();
  await expect(page.getByText("今天辛苦了，好好休息")).toBeVisible();
  await expect(page.locator(".payday-shortcut")).toContainText("下次发薪");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "税前月薪" })).toHaveValue(
    "22000",
  );
  await expect(page.getByLabel("晚饭开始")).toHaveValue("18:15");
  await expect(page.getByLabel("晚饭结束")).toHaveValue("19:15");
  await expect(
    page.getByRole("switch", { name: "排除公共假期" }),
  ).toHaveAttribute("aria-checked", "true");
  const dimensions = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((win) => !win.webContents.getURL().includes("window=floating")).getBounds(),
  );
  expect(dimensions.width).toBe(440);
  expect(dimensions.height).toBe(680);
  expect(errors).toEqual([]);
  console.log(
    "PASS: dinner configuration and pause/resume during meals, public holidays and makeup workdays, manual holiday override, settings, salary timer, privacy, alternate schedule, finish/history, tray hide/reopen, persistence, 440×680 window.",
  );
  console.log(`Isolated data: ${userData}`);
} finally {
  // All state writes are explicitly checked above; ensure failed tests also close the isolated app.
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
}
