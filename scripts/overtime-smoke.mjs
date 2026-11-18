import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { seedHolidayCache } from "./test-holiday-cache.mjs";

await mkdir(".cache", { recursive: true });
const userData = await mkdtemp(resolve(".cache/overtime-ui-"));
await seedHolidayCache(userData);
await writeFile(join(userData, "state.json"), JSON.stringify({ version: 1, settings: { monthlySalary: 17400 }, records: {} }));
const env = { ...process.env, TOUCHFISH_USER_DATA: userData, TOUCHFISH_KEEP_OPEN: "1", TOUCHFISH_HOLIDAYS_AUTO_REFRESH: "0" };
delete env.ELECTRON_RUN_AS_NODE;
const desktop = await electron.launch({ executablePath: electronPath, args: ["."], env });

const currency = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" });
const readState = async () => JSON.parse(await readFile(join(userData, "state.json"), "utf8"));

try {
  await expect.poll(() => desktop.windows().some(page => page.url().endsWith("/index.html"))).toBe(true);
  const main = desktop.windows().find(page => page.url().endsWith("/index.html"));
  await expect(main.getByText("今日已赚", { exact: true })).toBeVisible();
  await main.clock.install({ time: new Date("2026-10-09T08:59:59") });
  await main.clock.pauseAt(new Date("2026-10-09T09:00:00"));
  await main.reload();
  const button = name => main.getByRole("button", { name, exact: true });
  const kind = main.getByLabel("加班类型", { exact: true });
  const panel = main.getByRole("region", { name: "加班计算与记录" });
  const back = () => button("返回").click();
  const open = () => button("加班").click();
  const save = () => button("保存加班").click();
  const row = date => main.locator(".overtime-record").filter({ hasText: date });

  await main.getByRole("button", { name: /开始工作/ }).click();
  await open();
  await expect(button("开始加班")).toBeDisabled();
  await back();
  await button("暂停计时").click();
  await open();
  await expect(kind).toHaveValue("");
  await kind.selectOption("weekday");
  await button("开始加班").click();
  await back();
  await expect(main.getByRole("button", { name: /继续工作/ })).toBeDisabled();
  await main.clock.fastForward(3_600_000);
  await expect(main.locator(".earnings > span").nth(1)).toHaveText("150.00");
  await button("加班计时中").click();
  await expect(panel.getByLabel("当前加班时长")).toHaveText("01:00:00");
  await expect(panel.getByLabel("当前加班费")).toHaveText(currency.format(150));
  await button("结束加班").click();
  await expect(row("2026-10-09")).toContainText(currency.format(150));

  await button("补录加班").click();
  await main.getByLabel("加班日期").fill("2026-10-01");
  await expect(panel.getByText(/法定节假日还是调休休息日/)).toBeVisible();
  await kind.selectOption("statutory");
  await main.getByLabel("实际加班时长（时）").fill("2");
  await expect(main.getByLabel("已补休时长（时）")).toHaveCount(0);
  await save();
  await expect(row("2026-10-01")).toContainText(currency.format(600));

  await main.getByLabel("加班日期").fill("2026-10-04");
  await kind.selectOption("rest");
  await main.getByLabel("实际加班时长（时）").fill("3");
  await main.getByLabel("已补休时长（时）").fill("1");
  await save();
  await expect(row("2026-10-04")).toContainText(currency.format(400));
  await button("编辑加班 2026-10-04").click();
  await main.getByLabel("已补休时长（时）").fill("2");
  await save();
  await expect(row("2026-10-04")).toContainText(currency.format(200));

  await button("设置加班基数").click();
  await main.getByLabel("默认加班月工资基数").fill("34800");
  await button("保存基数").click();
  await expect(row("2026-10-09")).toContainText(currency.format(150));
  await button("隐藏金额").click();
  await expect(row("2026-10-01")).toContainText("金额已隐藏");
  await expect(main.getByLabel("本笔加班月工资基数")).toHaveAttribute("type", "password");
  await button("显示金额").click();
  await back();
  await button("薪资周期").click();
  await expect(main.locator(".payroll-total > strong")).toHaveText("¥950.00");
  await expect(main.locator(".history-overtime")).toContainText("6.00 小时");

  await expect.poll(async () => (await readState()).overtime?.entries.length).toBe(3);
  await main.reload();
  await open();
  await expect(row("2026-10-04")).toContainText(currency.format(200));
  await button("删除加班 2026-10-04").click();
  await button("确认删除").click();
  await expect(row("2026-10-04")).toHaveCount(0);
  await expect.poll(async () => (await readState()).overtime?.entries.length).toBe(2);

  await kind.selectOption("weekday");
  await button("开始加班").click();
  await main.clock.runFor(3000);
  await expect(panel.getByLabel("当前加班时长")).toHaveText("00:00:03");
  await expect.poll(async () => (await readState()).overtime?.entries[0].startedAt).not.toBeNull();
  const quitAt = await main.evaluate(() => Date.now());
  await desktop.evaluate((_electron, timestamp) => { Date.now = () => timestamp; }, quitAt);
  const closed = desktop.waitForEvent("close", { timeout: 10000 });
  await main.evaluate(() => window.touchFish.quit()).catch(error => { if (!main.isClosed()) throw error; });
  await closed;
  const last = (await readState()).overtime.entries[0];
  expect(last).toMatchObject({ startedAt: null, endsAt: null, seconds: 3, monthlyBase: 34800 });

  console.log("PASS: live overtime, ordinary timer exclusion, all three rates, partial compensatory leave, payroll aggregation, fixed bases, privacy, restart, record deletion and normal exit settlement.");
} finally {
  await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await desktop.close().catch(() => {});
}
