import { connectDock } from '@harness-dock/client';

const dock = await connectDock('.local/client.json');
try {
  const task = await dock.run({
    prompt: '回复 hello',
    receipt: '.local/hello.json', // 每个新任务使用新文件；已有文件会拒绝重派。
    // nodeId: '从 dock.listNodes() 选取', // 多设备时必填。
  });
  console.log(task.result); // 检查 state；原生结果字段因 Harness 而异。
} finally {
  await dock.close();
}
