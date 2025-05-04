import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { sleep } from "../sleep.ts";

Deno.test("sleep関数のテスト", async () => {
  const start = Date.now();
  await sleep(100);
  const end = Date.now();

  // 少なくとも指定時間（またはそれに近い時間）待機していることを確認
  assertNotEquals(end - start < 50, true, "sleepは指定時間待機すべきです");
});

Deno.test("sleep関数のアボートテスト", async () => {
  const controller = new AbortController();
  const start = Date.now();

  // 非同期でsleepを中断
  setTimeout(() => controller.abort(), 50);

  await assertRejects(() => sleep(500, { signal: controller.signal }));

  const end = Date.now();

  assertEquals(
    end - start < 100,
    true,
    "sleepはアボートされた時点で終了するべきです",
  );
});
