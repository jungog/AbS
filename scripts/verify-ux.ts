/**
 * 用真实浏览器验证用户报的三个问题的修复：
 *  1. 界面上是否明确写出「我要收什么颜色、几张」
 *  2. 手里没有识破 / 截获时，是否还会弹「放弃响应」
 *  3. 收下的情报是否出现在「我的情报」里
 *
 * 跑一局（单人 + AI），边打边核对。断言失败会打印现场，方便定位。
 */
import { chromium, type Page } from 'playwright';

const URL = process.env.ABS_URL ?? 'http://localhost:5173/';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    fails.push(`${name}${detail ? `：${detail}` : ''}`);
    console.log(`  ✖ ${name}${detail ? `：${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tabs-line button', { timeout: 15_000 });
  await page.locator('.tabs-line button', { hasText: '本地' }).click();
  await sleep(300);
  await page.locator('.mode-card', { hasText: '单人 + AI' }).click();
  await sleep(200);
  await page.locator('button', { hasText: '开始对局' }).click();
  await page.waitForSelector('.battle', { timeout: 10_000 });
  await page.waitForSelector('.pick-card', { timeout: 10_000 });
  await page.locator('.pick-card').first().click();
  await sleep(1000);

  const myCard = () => page.locator('.pcard.me').first();
  const goalBar = () => page.locator('.goalbar').first();

  /* ---------------- 1. 目标是否写明 ---------------- */
  console.log('\n[1] 目标是否写在界面上');
  const meText = ((await myCard().textContent()) ?? '').replace(/\s+/g, ' ');
  const identity =
    meText.includes('军情局') ? 'blue' : meText.includes('潜伏战线') ? 'red' : meText.includes('特工') ? 'agent' : null;
  check('能读出自己的身份', Boolean(identity), meText.slice(0, 40));

  check('界面上有目标条', (await goalBar().count()) === 1);
  const goalText = ((await goalBar().textContent()) ?? '').replace(/\s+/g, ' ').trim();
  console.log(`    目标条：${goalText}`);

  if (identity === 'blue' || identity === 'red') {
    const want = identity === 'blue' ? '蓝' : '红';
    const other = identity === 'blue' ? '红' : '蓝';
    check(`目标条写明要收${want}色`, goalText.includes(`目标`) && goalText.includes(`${want}色`));
    check(`目标条没把${other}色写进目标`, !goalText.includes(`集齐 3 张${other}色`), goalText);
    check('目标条给出「还差几张」', /[红蓝] \d\/\d/.test(goalText), goalText);
    check('目标条标出黑色死亡线', /黑色 \d\/\d/.test(goalText), goalText);
    check(
      '自己的玩家卡上也有目标进度',
      /[红蓝] \d\/\d/.test(((await myCard().textContent()) ?? '').replace(/\s+/g, ' ')),
    );
  } else {
    check('特工目标条写机密任务', goalText.includes('机密任务'), goalText);
  }

  /* ---------------- 2/3. 边打边核对 ---------------- */
  console.log('\n[2] 没有响应牌时是否还会被要求「放弃响应」');
  console.log('[3] 收下的情报是否出现在「我的情报」里');

  let responsePrompts = 0;
  let responseWithoutCard = 0;
  let receives = 0;
  let deaths = 0;
  let intelMismatch = 0;
  let recvInfoSeen = 0;

  for (let step = 0; step < 240; step++) {
    if ((await page.locator('.result').count()) > 0) break;

    const pick = page.locator('.pick-card').first();
    if ((await pick.count()) > 0) {
      await pick.click();
      await sleep(320);
      continue;
    }

    const barText = ((await page.locator('.actionbar').first().textContent().catch(() => '')) ?? '')
      .replace(/\s+/g, ' ');

    // 响应窗口：核对手里到底有没有能用的牌
    if (barText.includes('响应') && (await page.locator('.actionbar button').filter({ hasText: '放弃响应' }).count()) > 0) {
      responsePrompts++;
      const names = await page.locator('.actionbar .hand .card .card-fn').allTextContents();
      const canUse = names.some((t) => t.includes('识破') || t.includes('截获'));
      if (!canUse) {
        responseWithoutCard++;
        console.log(`    ✖ 无牌却弹响应：手牌 = ${names.join('/') || '（空）'}`);
      }
    }

    // 接收决策：核对说明行
    if (barText.includes('接收决策')) {
      const recv = (await page.locator('.recv-color').count()) > 0;
      if (recv) recvInfoSeen++;
    }

    // 收下情报：核对「我的情报」
    const acceptBtn = page.locator('.actionbar button:not([disabled])').filter({ hasText: '收下' });
    if ((await acceptBtn.count()) > 0) {
      const beforeCards = await page.locator('.intel-card').count();
      const beforeLabel = ((await page.locator('.intel-strip .section-label').textContent().catch(() => '')) ?? '')
        .replace(/\s+/g, ' ');
      await acceptBtn.first().click();
      await sleep(430);

      // 这一收正好凑满 3 张黑 = 自己出局，出局时情报按规则全部进弃牌堆，
      // 「我的情报」会清零。这是规则，不是 bug，不能算进「没增加」。
      const died =
        (await page.locator('.pcard.me.dead').count()) > 0 ||
        (await page.locator('.log-item').allTextContents()).slice(-4).some((t) => t.includes('出局'));

      const afterCards = await page.locator('.intel-card').count();
      const afterLabel = ((await page.locator('.intel-strip .section-label').textContent().catch(() => '')) ?? '')
        .replace(/\s+/g, ' ');

      if (died) {
        deaths++;
        console.log(`    · 这一收导致出局，情报按规则清空（${beforeCards}→${afterCards}），不计入`);
      } else {
        receives++;
        if (afterCards !== beforeCards + 1) {
          intelMismatch++;
          console.log(`    ✖ 情报条没增加：卡 ${beforeCards}→${afterCards}，标签「${beforeLabel}」→「${afterLabel}」`);
        }
      }
      continue;
    }

    // 正常推进
    let did = false;
    for (const kw of ['结束出牌', '收下', '放弃响应']) {
      const b = page.locator('.actionbar button:not([disabled])').filter({ hasText: kw });
      if ((await b.count()) > 0) {
        await b.first().click();
        did = true;
        break;
      }
    }
    if (!did) {
      const cards = page.locator('.actionbar .hand .card:not(.selected)');
      for (let k = 0; k < 3 && !did; k++) {
        if ((await cards.count()) === 0) break;
        await cards.first().click();
        await sleep(110);
        for (const kw of ['传出这张情报', '确认弃牌']) {
          const b = page.locator('.actionbar button:not([disabled])').filter({ hasText: kw });
          if ((await b.count()) > 0) {
            await b.first().click();
            did = true;
            break;
          }
        }
      }
    }
    await sleep(did ? 240 : 380);
  }

  check('没有响应牌时不会弹响应窗口', responseWithoutCard === 0, `${responseWithoutCard}/${responsePrompts} 次`);
  // 注意：这里**不能**断言「响应窗口必须出现过」。
  // 修好之后，只有手里真有【识破】/【截获】的人才会被问，而抽到什么牌是随机的 ——
  // 一局里一次都没出现是正常的，断言它就等于让测试随机红。
  // 这条规则的正反两个方向由 feature-test 的固定牌面用例钉死（「响应窗口只弹给手里真有牌的人」）。
  console.log(
    `    响应窗口出现 ${responsePrompts} 次` +
      (responsePrompts === 0 ? '（本局没抽到识破/截获，属正常；规则由 feature-test 覆盖）' : ''),
  );
  check('接收决策有颜色说明行', recvInfoSeen > 0, `出现 ${recvInfoSeen} 次`);
  check('每次收下情报后「我的情报」都增加一张', intelMismatch === 0, `${intelMismatch}/${receives} 次`);
  check(
    '至少收下过情报（否则这条没被覆盖）',
    receives + deaths > 0,
    `收下 ${receives} 次、因收下而出局 ${deaths} 次`,
  );
  check('页面无运行时错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  await page.screenshot({ path: 'shots/ux-fix.png' });
  console.log(`\n截图：shots/ux-fix.png`);
  console.log(`\n通过 ${pass} 项${fails.length ? `，失败 ${fails.length} 项` : '，全部通过'}`);
  fails.forEach((f) => console.log(`  - ${f}`));

  await browser.close();
  if (fails.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
