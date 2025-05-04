import { assertEquals, assertRejects } from "@std/assert";
import { sleep } from "../sleep.ts";
import { JobQueue } from "../jobqueue.ts";

// テスト用に追加のsleep関数ラッパー（テスト可能性向上のため）
const testSleep = async (ms: number): Promise<void> => {
  await sleep(ms);
};

Deno.test("基本的なジョブ処理が行われる", async () => {
  const queue = new JobQueue<string, number>(
    async (data, signal) => {
      await sleep(10, { signal });
      return data.length;
    },
    2,
    0,
  );

  const job = queue.addJob("test");
  assertEquals(await job, 4);
  queue.dispose();
});

Deno.test("並行実行数の制限が有効", async () => {
  const maxConcurrent = 2;
  const executionOrder: number[] = [];

  const queue = new JobQueue<number, number>(
    async (data, signal) => {
      await sleep(data * 10, { signal });
      executionOrder.push(data);
      return data;
    },
    maxConcurrent,
    0,
  );

  // 3つのジョブを追加（実行時間が異なる）
  const job3 = queue.addJob(3); // 30ms
  const job1 = queue.addJob(1); // 10ms
  const job2 = queue.addJob(2); // 20ms

  // すべてのジョブが完了するまで待機
  await Promise.all([job1, job2, job3]);

  // 最大並行実行数が2なので、最初に3と1が実行され、
  // 1が完了した後に2が実行される
  assertEquals(executionOrder, [1, 3, 2]);
  queue.dispose();
});

Deno.test("JobのAbortが有効", async () => {
  const executedJobs: string[] = [];

  const queue = new JobQueue<string, string>(
    async (data, signal) => {
      try {
        await sleep(50, { signal });
        executedJobs.push(data);
        return `Completed: ${data}`;
      } catch (error) {
        if (error instanceof Error && error.message === "Aborted") {
          throw new Error(`Aborted: ${data}`);
        }
        throw error;
      }
    },
    1,
    0,
  );

  const job1 = queue.addJob("job1");
  const job2 = queue.addJob("job2");

  // job2をアボート
  setTimeout(() => {
    job2.abort();
  }, 10);

  await assertRejects(
    () => job2,
    Error,
    "Job job-2 aborted",
  );

  // job1はそのまま実行
  const result1 = await job1;
  assertEquals(result1, "Completed: job1");

  // アボートされたジョブは実行結果に含まれない
  assertEquals(executedJobs, ["job1"]);
  queue.dispose();
});

Deno.test("複数のイベントリスナーが動作する", async () => {
  const events: string[] = [];
  const events2: string[] = [];

  const queue = new JobQueue<string, number>(
    async (data, signal) => {
      await sleep(10, { signal });
      if (data === "error") {
        throw new Error("Test error");
      }
      return data.length;
    },
    2,
    0,
  );

  // 最初のセットのリスナー
  const startListener1 = (
    { jobId, data }: { jobId: string; data: string },
  ) => {
    events.push(`start1:${jobId}:${data}`);
  };

  const completeListener1 = (
    { jobId, result }: { jobId: string; result: number },
  ) => {
    events.push(`complete1:${jobId}:${result}`);
  };

  const errorListener1 = (
    { jobId, error }: { jobId: string; error: Error },
  ) => {
    events.push(`error1:${jobId}:${error.message}`);
  };

  // 2番目のセットのリスナー
  const startListener2 = (
    { jobId, data }: { jobId: string; data: string },
  ) => {
    events2.push(`start2:${jobId}:${data}`);
  };

  const completeListener2 = (
    { jobId, result }: { jobId: string; result: number },
  ) => {
    events2.push(`complete2:${jobId}:${result}`);
  };

  // リスナーを追加
  queue.addEventListener("jobStart", startListener1);
  queue.addEventListener("jobComplete", completeListener1);
  queue.addEventListener("jobError", errorListener1);

  queue.addEventListener("jobStart", startListener2);
  queue.addEventListener("jobComplete", completeListener2);

  // ジョブを実行
  const job1 = queue.addJob("test");
  await job1;

  // 最初のリスナーを削除
  queue.removeEventListener("jobStart", startListener1);

  await assertRejects(() => queue.addJob("error"), "must be error");

  // 両方のイベントセットを確認

  // 最初のリスナーセット
  // startListener1はremoveされたので2回目のジョブでは呼ばれない
  assertEquals(events.includes("start1:job-1:test"), true);
  assertEquals(events.includes("start1:job-2:error"), false);
  assertEquals(events.includes("complete1:job-1:4"), true);
  assertEquals(events.includes("error1:job-2:Test error"), true);

  // 2番目のリスナーセット（両方のジョブで呼ばれる）
  assertEquals(events2.includes("start2:job-1:test"), true);
  assertEquals(events2.includes("start2:job-2:error"), true);
  assertEquals(events2.includes("complete2:job-1:4"), true);

  queue.dispose();
});

Deno.test("実行間隔の設定が有効", async () => {
  const executionTimes: number[] = [];

  const queue = new JobQueue<string, number>(
    async (data, signal) => {
      executionTimes.push(performance.now());
      await sleep(10, { signal });
      return data.length;
    },
    1,
    100, // 100ms間隔
  );

  const startTime = performance.now();
  executionTimes.push(startTime);

  // 3つのジョブを追加
  const job1 = queue.addJob("one");
  const job2 = queue.addJob("two");
  const job3 = queue.addJob("three");

  // すべてのジョブが完了するまで待機
  await Promise.all([job1, job2, job3]);

  // 各ジョブの実行開始時間の差が約100ms以上あることを確認
  const timeDiff1 = executionTimes[1] - executionTimes[0];
  const timeDiff2 = executionTimes[2] - executionTimes[1];
  const timeDiff3 = executionTimes[3] - executionTimes[2];

  // 許容誤差を考慮して80ms以上あれば成功とする
  assertEquals(timeDiff1 >= 80, true);
  assertEquals(timeDiff2 >= 80, true);
  assertEquals(timeDiff3 >= 80, true);

  queue.dispose();
});

Deno.test("ジョブIDが取得できる", async () => {
  const queue = new JobQueue<string, number>(
    (data) => {
      return Promise.resolve(data.length);
    },
  );

  const job1 = queue.addJob("test1");
  const job2 = queue.addJob("test2");

  assertEquals(job1.jobId, "job-1");
  assertEquals(job2.jobId, "job-2");

  queue.dispose();
  await assertRejects(() => job1);
  await assertRejects(() => job2);
});

Deno.test("キューの破棄が有効", async () => {
  const queue = new JobQueue<string, number>(
    async (data, signal) => {
      await sleep(100, { signal });
      return data.length;
    },
  );

  const job = queue.addJob("test");

  // キューを破棄
  queue.dispose();

  // ジョブはエラーで拒否されるはず
  await assertRejects(
    async () => await job,
    Error,
    "JobQueue disposed",
  );
});

Deno.test("新規ジョブ追加時に処理が再開される", async () => {
  const processedJobs: string[] = [];

  const queue = new JobQueue<string, string>(
    async (data, signal) => {
      await sleep(10, { signal });
      processedJobs.push(data);
      return data;
    },
    1,
    0,
  );

  // 最初のジョブを実行
  const job1 = queue.addJob("job1");
  await job1;

  // ここで処理ループは終了しているはず

  // しばらく待機
  await testSleep(50);

  // 新しいジョブを追加すると処理が再開されるはず
  const job2 = queue.addJob("job2");
  await job2;

  assertEquals(processedJobs, ["job1", "job2"]);
  queue.dispose();
});
