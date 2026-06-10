import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type CpuSnapshot = {
  idle: number;
  total: number;
};

type NetworkSnapshot = {
  received: number;
  transmitted: number;
  timestamp: number;
};

type GpuStats = {
  index: number;
  name: string;
  utilization: number;
  memoryUsed: number;
  memoryTotal: number;
  memoryPercent: number;
  temperature: number;
  powerDraw?: number;
  powerLimit?: number;
};

type SystemStats = {
  cpuPercent: number;
  memory: {
    total: number;
    used: number;
    free: number;
    percent: number;
  };
  storage?: {
    filesystem: string;
    size: string;
    used: string;
    available: string;
    percent: number;
    mount: string;
  };
  network: {
    received: number;
    transmitted: number;
    receiveRate: number;
    transmitRate: number;
  };
  gpus: GpuStats[];
  loadAverage: number[];
  uptime: number;
  platform: string;
  hostname: string;
};

class SystemMonitorProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private timer?: NodeJS.Timeout;
  private previousCpu = getCpuSnapshot();
  private previousNetwork = getNetworkSnapshot();

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message?.type === 'refresh' || message?.type === 'ready') {
        this.refresh();
      }
    });

    webviewView.webview.html = this.getHtml();

    webviewView.onDidDispose(() => {
      this.stop();
      this.view = undefined;
    });

    this.start();
  }

  refresh(): void {
    void this.update();
  }

  private start(): void {
    this.stop();
    void this.update();

    const interval = vscode.workspace
      .getConfiguration('systemMonitor')
      .get<number>('refreshInterval', 2000);

    this.timer = setInterval(() => void this.update(), interval);
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async update(): Promise<void> {
    if (!this.view) {
      return;
    }

    const stats = await collectStats(this.previousCpu, this.previousNetwork);
    this.previousCpu = getCpuSnapshot();
    this.previousNetwork = getNetworkSnapshot();
    this.view.webview.postMessage({ type: 'stats', stats });
  }

  private getHtml(): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>系统监控</title>
  <style>
    body {
      padding: 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
    }
    .header {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
    }
    .host {
      font-weight: 700;
    }
    .muted {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .dashboard {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
    }
    .card {
      padding: 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      background: var(--vscode-editor-background);
    }
    .card-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      font-weight: 700;
    }
    .gauge {
      --percent: 0;
      width: 118px;
      height: 118px;
      margin: 0 auto 10px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: conic-gradient(var(--vscode-charts-blue) calc(var(--percent) * 1%), var(--vscode-input-background) 0);
    }
    .gauge::before {
      content: '';
      position: absolute;
      width: 84px;
      height: 84px;
      border-radius: 50%;
      background: var(--vscode-editor-background);
    }
    .gauge-value {
      position: relative;
      font-size: 22px;
      font-weight: 800;
    }
    .stats {
      display: grid;
      gap: 6px;
      font-size: 12px;
    }
    .row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .wide {
      grid-column: 1 / -1;
    }
    .gpu-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 12px;
    }
    button {
      padding: 7px 10px;
      color: var(--vscode-button-foreground);
      border: 0;
      border-radius: 4px;
      background: var(--vscode-button-background);
      cursor: pointer;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="host" id="host">系统监控</div>
      <div class="muted" id="platform">--</div>
    </div>
    <button id="refresh">刷新</button>
  </div>

  <div class="dashboard">
    <section class="card">
      <div class="card-title"><span>CPU</span><span class="muted" id="load">--</span></div>
      <div class="gauge" id="cpuGauge"><div class="gauge-value" id="cpu">--%</div></div>
      <div class="stats"><div class="row"><span>运行时间</span><span id="uptime">--</span></div></div>
    </section>

    <section class="card">
      <div class="card-title"><span>RAM</span><span class="muted" id="memoryText">--</span></div>
      <div class="gauge" id="memoryGauge"><div class="gauge-value" id="memory">--%</div></div>
      <div class="stats"><div class="row"><span>可用</span><span id="memoryFree">--</span></div></div>
    </section>

    <section class="card">
      <div class="card-title"><span>存储</span><span class="muted" id="storageMount">--</span></div>
      <div class="gauge" id="storageGauge"><div class="gauge-value" id="storage">--%</div></div>
      <div class="stats"><div class="row"><span>已用 / 总量</span><span id="storageText">--</span></div></div>
    </section>

    <section class="card">
      <div class="card-title"><span>网络</span><span class="muted">实时速率</span></div>
      <div class="stats">
        <div class="row"><span>下载</span><strong id="rxRate">--</strong></div>
        <div class="row"><span>上传</span><strong id="txRate">--</strong></div>
        <div class="row"><span>累计接收</span><span id="rxTotal">--</span></div>
        <div class="row"><span>累计发送</span><span id="txTotal">--</span></div>
      </div>
    </section>

    <section class="card wide">
      <div class="card-title"><span>GPU</span><span class="muted" id="gpuCount">--</span></div>
      <div class="gpu-grid" id="gpuGrid"></div>
    </section>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    vscode.postMessage({ type: 'ready' });
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    window.addEventListener('message', event => render(event.data.stats));

    function render(stats) {
      setText('host', stats.hostname);
      setText('platform', stats.platform);
      setGauge('cpuGauge', 'cpu', stats.cpuPercent);
      setText('load', stats.loadAverage.map(v => v.toFixed(2)).join(' / '));
      setText('uptime', formatDuration(stats.uptime));

      setGauge('memoryGauge', 'memory', stats.memory.percent);
      setText('memoryText', formatBytes(stats.memory.used) + ' / ' + formatBytes(stats.memory.total));
      setText('memoryFree', formatBytes(stats.memory.free));

      if (stats.storage) {
        setGauge('storageGauge', 'storage', stats.storage.percent);
        setText('storageMount', stats.storage.mount);
        setText('storageText', stats.storage.used + ' / ' + stats.storage.size);
      }

      setText('rxRate', formatBytes(stats.network.receiveRate) + '/s');
      setText('txRate', formatBytes(stats.network.transmitRate) + '/s');
      setText('rxTotal', formatBytes(stats.network.received));
      setText('txTotal', formatBytes(stats.network.transmitted));

      renderGpus(stats.gpus);
    }

    function renderGpus(gpus) {
      setText('gpuCount', gpus.length ? gpus.length + ' 张' : '未检测到 nvidia-smi');
      const grid = document.getElementById('gpuGrid');
      if (!gpus.length) {
        grid.innerHTML = '<div class="muted">未检测到 NVIDIA GPU，或当前环境无法执行 nvidia-smi。</div>';
        return;
      }
      grid.innerHTML = gpus.map(gpu =>
        '<div class="card">' +
          '<div class="card-title"><span>GPU ' + gpu.index + '</span><span class="muted">' + escapeHtml(gpu.name) + '</span></div>' +
          '<div class="gauge" style="--percent:' + safePercent(gpu.utilization) + '"><div class="gauge-value">' + gpu.utilization.toFixed(0) + '%</div></div>' +
          '<div class="stats">' +
            '<div class="row"><span>显存</span><span>' + gpu.memoryUsed + ' / ' + gpu.memoryTotal + ' MB (' + gpu.memoryPercent.toFixed(0) + '%)</span></div>' +
            '<div class="row"><span>温度</span><span>' + gpu.temperature + ' °C</span></div>' +
            '<div class="row"><span>功耗</span><span>' + formatPower(gpu) + '</span></div>' +
          '</div>' +
        '</div>'
      ).join('');
    }

    function setGauge(gaugeId, valueId, percent) {
      const safe = safePercent(percent);
      document.getElementById(gaugeId).style.setProperty('--percent', safe);
      setText(valueId, safe.toFixed(0) + '%');
    }

    function safePercent(value) {
      return Math.max(0, Math.min(100, Number(value) || 0));
    }

    function formatPower(gpu) {
      if (gpu.powerDraw == null || gpu.powerLimit == null) {
        return '--';
      }
      return gpu.powerDraw.toFixed(1) + ' / ' + gpu.powerLimit.toFixed(1) + ' W';
    }

    function setText(id, text) {
      document.getElementById(id).textContent = text;
    }

    function formatBytes(value) {
      const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
      let index = 0;
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index++;
      }
      return value.toFixed(index === 0 ? 0 : 1) + ' ' + units[index];
    }

    function formatDuration(seconds) {
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return days + '天 ' + hours + '小时 ' + minutes + '分';
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>\"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[char]));
    }
  </script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SystemMonitorProvider();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('systemMonitor.view', provider),
    vscode.commands.registerCommand('systemMonitor.refresh', () => provider.refresh())
  );
}

export function deactivate(): void { }

async function collectStats(previousCpu: CpuSnapshot, previousNetwork: NetworkSnapshot): Promise<SystemStats> {
  const currentCpu = getCpuSnapshot();
  const idleDiff = currentCpu.idle - previousCpu.idle;
  const totalDiff = currentCpu.total - previousCpu.total;
  const cpuPercent = totalDiff > 0 ? (1 - idleDiff / totalDiff) * 100 : 0;
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const currentNetwork = getNetworkSnapshot();
  const elapsedSeconds = Math.max((currentNetwork.timestamp - previousNetwork.timestamp) / 1000, 1);

  return {
    cpuPercent,
    memory: {
      total: totalMemory,
      used: usedMemory,
      free: freeMemory,
      percent: totalMemory > 0 ? (usedMemory / totalMemory) * 100 : 0
    },
    storage: await getStorageStats(),
    network: {
      received: currentNetwork.received,
      transmitted: currentNetwork.transmitted,
      receiveRate: Math.max(0, (currentNetwork.received - previousNetwork.received) / elapsedSeconds),
      transmitRate: Math.max(0, (currentNetwork.transmitted - previousNetwork.transmitted) / elapsedSeconds)
    },
    gpus: await getGpuStats(),
    loadAverage: os.loadavg(),
    uptime: os.uptime(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    hostname: os.hostname()
  };
}

function getCpuSnapshot(): CpuSnapshot {
  return os.cpus().reduce<CpuSnapshot>(
    (snapshot: CpuSnapshot, cpu: os.CpuInfo) => {
      const times = cpu.times as Record<string, number>;
      const total = Object.values(times).reduce((sum, value) => sum + value, 0);
      snapshot.idle += cpu.times.idle;
      snapshot.total += total;
      return snapshot;
    },
    { idle: 0, total: 0 }
  );
}

async function getStorageStats(): Promise<SystemStats['storage']> {
  try {
    const { stdout } = await execFileAsync('df', ['-h', os.homedir()]);
    const lines = stdout.trim().split('\n');
    const values = lines[1]?.trim().split(/\s+/);

    if (!values || values.length < 6) {
      return undefined;
    }

    return {
      filesystem: values[0],
      size: values[1],
      used: values[2],
      available: values[3],
      percent: Number(values[4].replace('%', '')) || 0,
      mount: values.slice(5).join(' ')
    };
  } catch {
    return undefined;
  }
}

function getNetworkSnapshot(): NetworkSnapshot {
  try {
    const content = fs.readFileSync('/proc/net/dev', 'utf8');
    const lines = content.split('\n').slice(2);

    return lines.reduce<NetworkSnapshot>(
      (total: NetworkSnapshot, line: string) => {
        const [namePart, dataPart] = line.split(':');
        if (!namePart || !dataPart) {
          return total;
        }

        const name = namePart.trim();
        if (name === 'lo') {
          return total;
        }

        const values = dataPart.trim().split(/\s+/).map(Number);
        total.received += values[0] || 0;
        total.transmitted += values[8] || 0;
        return total;
      },
      { received: 0, transmitted: 0, timestamp: Date.now() }
    );
  } catch {
    return { received: 0, transmitted: 0, timestamp: Date.now() };
  }
}

async function getGpuStats(): Promise<GpuStats[]> {
  try {
    const fields = [
      'index',
      'name',
      'utilization.gpu',
      'memory.used',
      'memory.total',
      'temperature.gpu',
      'power.draw',
      'power.limit'
    ].join(',');
    const { stdout } = await execFileAsync('nvidia-smi', [`--query-gpu=${fields}`, '--format=csv,noheader,nounits']);

    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line: string) => {
        const [index, name, utilization, memoryUsed, memoryTotal, temperature, powerDraw, powerLimit] = line
          .split(',')
          .map((value: string) => value.trim());
        const used = Number(memoryUsed) || 0;
        const total = Number(memoryTotal) || 0;

        return {
          index: Number(index) || 0,
          name,
          utilization: Number(utilization) || 0,
          memoryUsed: used,
          memoryTotal: total,
          memoryPercent: total > 0 ? (used / total) * 100 : 0,
          temperature: Number(temperature) || 0,
          powerDraw: parseOptionalNumber(powerDraw),
          powerLimit: parseOptionalNumber(powerLimit)
        };
      });
  } catch {
    return [];
  }
}

function parseOptionalNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
