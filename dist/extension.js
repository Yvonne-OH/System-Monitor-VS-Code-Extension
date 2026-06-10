const fs = require('fs');
const os = require('os');
const vscode = require('vscode');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

class SystemMonitorProvider {
  constructor() {
    this.view = undefined;
    this.timer = undefined;
    this.previousCpu = getCpuSnapshot();
    this.previousNetwork = getNetworkSnapshot();
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage(message => {
      if (!message) return;
      if (message.type === 'refresh' || message.type === 'ready') this.refresh();
      if (message.type === 'killProcess' && Number.isInteger(message.pid)) void this.killProcess(message.pid);
      if (message.type === 'cleanGpu') void this.cleanGpu();
      if (message.type === 'cleanCpu') void this.cleanCpu();
    });
    webviewView.webview.html = this.getHtml();
    webviewView.onDidDispose(() => {
      this.stop();
      this.view = undefined;
    });
    this.start();
  }

  refresh() { void this.update(); }

  start() {
    this.stop();
    void this.update();
    const interval = vscode.workspace.getConfiguration('systemMonitor').get('refreshInterval', 2000);
    this.timer = setInterval(() => void this.update(), interval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async update() {
    if (!this.view) return;
    try {
      const stats = await collectStats(this.previousCpu, this.previousNetwork);
      this.previousCpu = getCpuSnapshot();
      this.previousNetwork = getNetworkSnapshot();
      this.view.webview.postMessage({ type: 'stats', stats });
    } catch (error) {
      this.view.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  postAction(message) {
    if (this.view) this.view.webview.postMessage({ type: 'action', message });
  }

  async killProcess(pid) {
    try {
      const confirm = await vscode.window.showWarningMessage(`确认强制结束进程 ${pid}？`, { modal: true }, 'Kill');
      if (confirm !== 'Kill') {
        this.postAction('已取消 kill');
        this.refresh();
        return;
      }
      await killPid(pid);
      this.postAction(`已强制结束进程 ${pid}`);
      vscode.window.showInformationMessage(`已强制结束进程 ${pid}`);
      setTimeout(() => this.refresh(), 300);
    } catch (error) {
      const message = `kill 进程 ${pid} 失败：${error instanceof Error ? error.message : String(error)}`;
      this.postAction(message);
      vscode.window.showErrorMessage(message);
      this.refresh();
    }
  }

  async cleanGpu() {
    try {
      const confirm = await vscode.window.showWarningMessage('确认强制清理所有 GPU 计算进程？', { modal: true }, 'Clean GPU');
      if (confirm !== 'Clean GPU') {
        this.postAction('已取消清理 GPU');
        return;
      }
      const pids = await getGpuProcessIds();
      if (!pids.length) {
        vscode.window.showInformationMessage('没有检测到 GPU 计算进程');
        this.postAction('没有检测到 GPU 计算进程');
        this.refresh();
        return;
      }
      const killed = [];
      const failed = [];
      for (const pid of pids) {
        try {
          await killPid(pid);
          killed.push(pid);
        } catch (error) {
          failed.push(`${pid}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const message = `GPU 清理完成：成功 ${killed.length} 个，失败 ${failed.length} 个${failed.length ? '（' + failed.join('；') + '）' : ''}`;
      this.postAction(message);
      vscode.window.showInformationMessage(message);
      setTimeout(() => this.refresh(), 300);
    } catch (error) {
      const message = `清理 GPU 失败：${error instanceof Error ? error.message : String(error)}`;
      this.postAction(message);
      vscode.window.showErrorMessage(message);
    }
  }

  async cleanCpu() {
    try {
      const confirm = await vscode.window.showWarningMessage('确认强制清理 CPU 占用 >= 80% 的非系统进程？', { modal: true }, 'Clean CPU');
      if (confirm !== 'Clean CPU') {
        this.postAction('已取消清理 CPU');
        return;
      }
      const currentPid = process.pid;
      const processes = await getProcesses();
      const targets = processes.filter(item => item.pid !== currentPid && item.pid > 1 && item.cpu >= 80).map(item => item.pid);
      if (!targets.length) {
        vscode.window.showInformationMessage('没有检测到 CPU 占用 >= 80% 的进程');
        this.postAction('没有检测到 CPU 占用 >= 80% 的进程');
        this.refresh();
        return;
      }
      for (const pid of targets) await killPid(pid);
      this.postAction(`已强制清理 ${targets.length} 个高 CPU 进程`);
      vscode.window.showInformationMessage(`已强制清理 ${targets.length} 个高 CPU 进程`);
      setTimeout(() => this.refresh(), 300);
    } catch (error) {
      const message = `清理 CPU 失败：${error instanceof Error ? error.message : String(error)}`;
      this.postAction(message);
      vscode.window.showErrorMessage(message);
    }
  }

  getHtml() {
    const nonce = getNonce();
    const i18n = {
      zh: {
        appTitle: '系统监控', system: '系统', storage: '存储', viewDetails: '点击查看', usedTotal: '已用 / 总量', cpu: 'CPU', ram: 'RAM', uptime: '运行时间', free: '可用', network: '网络', liveRate: '实时速率', download: '下载', upload: '上传', totalRx: '累计接收', totalTx: '累计发送', sshNetwork: 'SSH 网络', gpu: 'GPU', storageDetail: '存储详情', processes: '进程', actionCol: '操作', pid: 'PID', cpuCol: 'CPU', memCol: '内存', cmd: '命令', kill: 'kill', cleanCpu: '清理 CPU', cleanGpu: '清理 GPU', sshEmpty: '当前未检测到 SSH TCP 连接', gpuEmpty: '未检测到 NVIDIA GPU，或当前环境无法执行 nvidia-smi。', processesEmpty: '没有读取到进程信息', disksEmpty: '没有读取到磁盘信息', actionStatus: '已发送 %s 请求...', killStatus: '已发送 kill 请求：%s', directionInbound: '入站', directionOutbound: '出站', disksLabel: '%d 个挂载点', processesLabel: '%d 个', gpusLabel: '%d 张', sshLabel: '%d 个连接', sshLabelZero: '0 个连接', gpusLabelZero: '0 张', processesLabelZero: '0 个', storageUsed: '可用 %s · %s', lang: '语言'
      },
      en: {
        appTitle: 'System Monitor', system: 'System', storage: 'Storage', viewDetails: 'View', usedTotal: 'Used / Total', cpu: 'CPU', ram: 'RAM', uptime: 'Uptime', free: 'Free', network: 'Network', liveRate: 'Live rate', download: 'Download', upload: 'Upload', totalRx: 'Total RX', totalTx: 'Total TX', sshNetwork: 'SSH', gpu: 'GPU', storageDetail: 'Storage detail', processes: 'Processes', actionCol: 'Action', pid: 'PID', cpuCol: 'CPU', memCol: 'MEM', cmd: 'Command', kill: 'kill', cleanCpu: 'Clean CPU', cleanGpu: 'Clean GPU', sshEmpty: 'No SSH TCP connections detected', gpuEmpty: 'No NVIDIA GPU detected, or nvidia-smi is unavailable.', processesEmpty: 'No process info', disksEmpty: 'No disk info', actionStatus: '%s request sent...', killStatus: 'Kill request sent: %s', directionInbound: 'in', directionOutbound: 'out', disksLabel: '%d mount(s)', processesLabel: '%d item(s)', gpusLabel: '%d GPU(s)', sshLabel: '%d connection(s)', sshLabelZero: '0 connection', gpusLabelZero: '0 GPU', processesLabelZero: '0 item', storageUsed: 'Free %s · %s', lang: 'Language'
      },
      ja: {
        appTitle: 'システムモニター', system: 'システム', storage: 'ストレージ', viewDetails: 'クリックで詳細', usedTotal: '使用 / 合計', cpu: 'CPU', ram: 'RAM', uptime: '稼働時間', free: '空き', network: 'ネットワーク', liveRate: 'リアルタイム速度', download: 'ダウンロード', upload: 'アップロード', totalRx: '受信合計', totalTx: '送信合計', sshNetwork: 'SSH ネットワーク', gpu: 'GPU', storageDetail: 'ストレージ詳細', processes: 'プロセス', actionCol: '操作', pid: 'PID', cpuCol: 'CPU', memCol: 'メモリ', cmd: 'コマンド', kill: 'kill', cleanCpu: 'CPU 清理', cleanGpu: 'GPU 清理', sshEmpty: 'SSH TCP 接続を検出できません', gpuEmpty: 'NVIDIA GPU を検出できないか、nvidia-smi が使えません。', processesEmpty: 'プロセス情報なし', disksEmpty: 'ディスク情報なし', actionStatus: '%s リクエスト送信済み...', killStatus: 'kill リクエスト送信済み：%s', directionInbound: '受信', directionOutbound: '送信', disksLabel: '%d マウント', processesLabel: '%d 個', gpusLabel: '%d 枚', sshLabel: '%d 接続', sshLabelZero: '0 接続', gpusLabelZero: '0 枚', processesLabelZero: '0 個', storageUsed: '空き %s · %s', lang: '言語'
      },
      ru: {
        appTitle: 'Системный монитор', system: 'Система', storage: 'Хранилище', viewDetails: 'Подробнее', usedTotal: 'Использовано / Всего', cpu: 'CPU', ram: 'RAM', uptime: 'Аптайм', free: 'Свободно', network: 'Сеть', liveRate: 'Текущая скорость', download: 'Загрузка', upload: 'Отправка', totalRx: 'Всего RX', totalTx: 'Всего TX', sshNetwork: 'SSH сеть', gpu: 'GPU', storageDetail: 'Подробно о дисках', processes: 'Процессы', actionCol: 'Действие', pid: 'PID', cpuCol: 'CPU', memCol: 'Память', cmd: 'Команда', kill: 'kill', cleanCpu: 'Очистить CPU', cleanGpu: 'Очистить GPU', sshEmpty: 'SSH TCP соединения не найдены', gpuEmpty: 'NVIDIA GPU не найдены или nvidia-smi недоступна.', processesEmpty: 'Нет информации о процессах', disksEmpty: 'Нет информации о дисках', actionStatus: 'Запрос %s отправлен...', killStatus: 'Запрос kill отправлен: %s', directionInbound: 'вход', directionOutbound: 'выход', disksLabel: 'точек монтирования: %d', processesLabel: 'процессов: %d', gpusLabel: 'GPU: %d', sshLabel: 'соединений: %d', sshLabelZero: '0 соединений', gpusLabelZero: '0 GPU', processesLabelZero: '0 процессов', storageUsed: 'Свободно %s · %s', lang: 'Язык'
      }
    };
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>${i18n.zh.appTitle}</title>
  <style>
    :root { --accent: #4da3ff; --danger: #ff5f57; --warn: #ffbd2e; --ok: #28c840; }
    body { padding: 12px; margin: 0; color: var(--fg); background: var(--bg); font-family: var(--vscode-font-family); }
    body.theme-dark { --bg: #14171c; --panel: #1f242b; --panel2: #2a3038; --fg: #e8eaed; --muted: #9aa4b2; --border: #343b45; }
    body.theme-light { --bg: #f6f8fb; --panel: #ffffff; --panel2: #edf1f7; --fg: #1f2328; --muted: #5d6673; --border: #d5dbe5; --scrollbar: #c8d0dc; --scrollbar-track: #edf1f7; }
    body.theme-midnight { --bg: #080f1f; --panel: #101a2e; --panel2: #17233a; --fg: #eaf2ff; --muted: #8ea4c3; --border: #243452; --scrollbar: #36537d; --scrollbar-track: #101a2e; }
    body.theme-forest { --bg: #0d1711; --panel: #14251b; --panel2: #1c3325; --fg: #e8f5ec; --muted: #91ad9a; --border: #294532; --scrollbar: #3f6d4d; --scrollbar-track: #14251b; }
    body.theme-purple { --bg: #17111f; --panel: #231832; --panel2: #302247; --fg: #f3eaff; --muted: #b8a3d7; --border: #45335f; --scrollbar: #674c8e; --scrollbar-track: #231832; }
    body.theme-dark { --scrollbar: #4a5563; --scrollbar-track: #1f242b; }
    .header { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin-bottom: 12px; }
    .host { font-weight: 800; }
    .muted { color: var(--muted); font-size: 12px; }
    .toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .dashboard { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: stretch; }
    .card { padding: 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel); box-shadow: 0 6px 18px rgba(0,0,0,.08); }
    .top-card { min-height: 230px; display: flex; flex-direction: column; }
    .storage-strip { min-height: auto; display: grid; gap: 8px; }
    .storage-strip .meter { height: 24px; }
    .network-card { min-height: auto; min-width: 0; overflow: hidden; }
    .network-card .stats { min-width: 0; }
    .network-card .row { min-width: 0; align-items: flex-start; }
    .network-card .row span:first-child { flex-shrink: 0; }
    .network-card .row span:last-child, .network-card .row strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
    @media (max-width: 360px) {
      .network-card .row { display: grid; grid-template-columns: 1fr; gap: 2px; }
      .network-card .row span:last-child, .network-card .row strong { text-align: left; }
    }
    .card.clickable { cursor: pointer; }
    .card-title { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 10px; font-weight: 800; }
    .gauge { --percent: 0; position: relative; width: 92px; height: 92px; margin: 0 auto 8px; border-radius: 50%; display: grid; place-items: center; background: conic-gradient(var(--accent) calc(var(--percent) * 1%), var(--panel2) 0); }
    .gauge::before { content: ''; position: absolute; width: 66px; height: 66px; border-radius: 50%; background: var(--panel); }
    .gauge-value { position: relative; font-size: 18px; font-weight: 900; }
    .stats { display: grid; gap: 7px; font-size: 12px; }
    .row { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
    .wide { grid-column: 1 / -1; }
    .gpu-grid, .disk-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
    .disk-card { padding: 8px; border-radius: 9px; font-size: 11px; }
    .disk-card .card-title { margin-bottom: 6px; }
    .disk-card .meter { height: 18px; }
    button, select { padding: 7px 9px; color: var(--fg); border: 1px solid var(--border); border-radius: 7px; background: var(--panel2); cursor: pointer; }
    button:disabled { opacity: .55; cursor: wait; }
    button.danger { color: #fff; border-color: var(--danger); background: var(--danger); }
    button.small { padding: 4px 7px; font-size: 11px; }
    .gpu-led { width: 10px; height: 10px; min-width: 10px; min-height: 10px; flex-shrink: 0; display: inline-block; border-radius: 50%; box-shadow: 0 0 10px currentColor; background: currentColor; }
    .gpu-led.ok { color: var(--ok); }
    .gpu-led.warn { color: var(--warn); }
    .gpu-led.danger { color: var(--danger); }
    .gpu-title-right { display: flex; align-items: center; gap: 8px; min-width: 0; }
    input[type="color"] { width: 34px; height: 30px; padding: 0; border: 1px solid var(--border); border-radius: 7px; background: transparent; }
    canvas { width: 100%; height: 72px; border-radius: 10px; background: var(--panel2); margin-top: 8px; }
    .meter { position: relative; overflow: hidden; height: 22px; border-radius: 999px; background: var(--panel2); border: 1px solid var(--border); }
    .meter-fill { position: absolute; inset: 0 auto 0 0; width: 0%; opacity: .35; background: var(--ok); transition: width .25s ease, background .25s ease; }
    .meter-label { position: relative; z-index: 1; height: 100%; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 12px; }
    .disk-page { max-height: calc(100vh - 118px); overflow: auto; scrollbar-color: var(--scrollbar) var(--scrollbar-track); }
    .disk-page::-webkit-scrollbar, .process-page::-webkit-scrollbar { width: 8px; height: 8px; }
    .disk-page::-webkit-scrollbar-track, .process-page::-webkit-scrollbar-track { background: var(--scrollbar-track); border-radius: 999px; }
    .disk-page::-webkit-scrollbar-thumb, .process-page::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 999px; }
    .disk-list { display: grid; gap: 10px; }
    .disk-row { padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel2); }
    .disk-row-head { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 5px; font-size: 11px; font-weight: 800; }
    .disk-row-foot { margin-top: 4px; color: var(--muted); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .disk-row .meter { width: 78%; height: 14px; }
    #sshList .row { min-width: 0; overflow: hidden; display: grid; grid-template-columns: minmax(0, 1fr) auto; }
    #sshList .row span:first-child { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #sshList .row .chip { flex-shrink: 0; }
    .chip { color: var(--muted); font-size: 11px; }
    .tabs { display: flex; gap: 8px; margin-bottom: 12px; }
    .tab { flex: 1; }
    .tab.active { color: #fff; background: var(--accent); border-color: var(--accent); }
    .page { display: none; }
    .page.active { display: block; }
    .process-list { display: grid; gap: 8px; }
    .process-row { display: grid; grid-template-columns: 46px 14px 56px 58px 70px minmax(0, 1fr); gap: 8px; align-items: center; padding: 9px; border: 1px solid var(--border); border-radius: 9px; background: var(--panel); font-size: 12px; }
    .process-row.header-row { position: sticky; top: 0; z-index: 1; color: var(--muted); background: var(--panel2); font-weight: 800; }
    .cmd { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .process-page { max-height: calc(100vh - 118px); overflow: auto; }
    .process-actions { display: flex; gap: 8px; margin-left: auto; }
    .lang-select { width: 56px; padding: 7px 6px; }
  </style>
</head>
<body>
  <div class="header">
    <div><div class="host" id="host">${i18n.zh.appTitle}</div><div class="muted" id="platform">--</div></div>
    <div class="toolbar">
      <select id="lang" class="lang-select" title="${i18n.zh.lang}"><option value="zh">中文</option><option value="en">EN</option><option value="ja">日</option><option value="ru">RU</option></select>
      <select id="theme"><option value="dark">dark</option><option value="light">light</option><option value="midnight">midnight</option><option value="forest">forest</option><option value="purple">purple</option></select>
      <input id="accent" type="color" value="#4da3ff" title="${i18n.zh.storage}">
    </div>
  </div>
  <div class="tabs"><button class="tab active" data-page="monitorPage" data-i18n="system">系统</button><button class="tab" data-page="storagePage" data-i18n="storage">存储</button><button class="tab" data-page="processPage" data-i18n="processes">进程</button></div>
  <div class="page active" id="monitorPage"><div class="dashboard">
    <section class="card top-card"><div class="card-title"><span data-i18n="cpu">CPU</span><span class="muted" id="load">--</span></div><div class="gauge" id="cpuGauge"><div class="gauge-value" id="cpu">--%</div></div><canvas class="mini-chart" id="cpuChart" width="320" height="62"></canvas><div class="stats"><div class="row"><span data-i18n="uptime">运行时间</span><span id="uptime">--</span></div></div></section>
    <section class="card top-card"><div class="card-title"><span data-i18n="ram">RAM</span><span class="muted" id="memoryText">--</span></div><div class="gauge" id="memoryGauge"><div class="gauge-value" id="memory">--%</div></div><canvas class="mini-chart" id="ramChart" width="320" height="62"></canvas><div class="stats"><div class="row"><span data-i18n="free">可用</span><span id="memoryFree">--</span></div></div></section>
    <section class="card wide storage-strip clickable" id="storageCard"><div class="card-title"><span data-i18n="storage">存储</span><span class="muted" id="storageMount" data-i18n-attr="viewDetails">点击查看</span></div><div class="meter"><div class="meter-fill" id="storageFill"></div><div class="meter-label" id="storage">--%</div></div><div class="stats"><div class="row"><span data-i18n="usedTotal">已用 / 总量</span><span id="storageText">--</span></div></div></section>
    <section class="card wide network-card"><div class="card-title"><span data-i18n="network">网络</span><span class="muted" data-i18n="liveRate">实时速率</span></div><canvas id="netChart" width="640" height="90"></canvas><div class="stats" style="margin-top:8px"><div class="row"><span data-i18n="download">下载</span><strong id="rxRate">--</strong></div><div class="row"><span data-i18n="upload">上传</span><strong id="txRate">--</strong></div><div class="row"><span data-i18n="totalRx">累计接收</span><span id="rxTotal">--</span></div><div class="row"><span data-i18n="totalTx">累计发送</span><span id="txTotal">--</span></div><div class="row"><span data-i18n="sshNetwork">SSH 网络</span><span class="muted" id="sshCount">--</span></div><div id="sshList"><div class="muted">--</div></div></div></section>
    <section class="card wide"><div class="card-title"><span data-i18n="gpu">GPU</span><span class="muted" id="gpuCount">--</span></div><div class="gpu-grid" id="gpuGrid"></div></section>
  </div></div>
  <div class="page disk-page" id="storagePage">
    <section class="card wide"><div class="card-title"><span data-i18n="storageDetail">存储详情</span><span class="muted" id="diskCount">--</span></div><div id="diskDetail"><div class="muted">--</div></div></section>
  </div>
  <div class="page process-page" id="processPage">
    <section class="card wide"><div class="card-title"><span data-i18n="processes">进程</span><span class="muted" id="processCount">--</span><div class="process-actions"><button class="danger" id="cleanCpu" data-i18n-attr="cleanCpu" data-i18n>清理 CPU</button><button class="danger" id="cleanGpu" data-i18n-attr="cleanGpu" data-i18n>清理 GPU</button></div></div><div class="muted" id="actionStatus" style="margin-bottom:8px">--</div><div class="process-list" id="processList"><div class="muted">--</div></div></section>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const I18N = ${JSON.stringify(i18n)};
    let state = vscode.getState() || { theme: 'dark', accent: '#4da3ff', lang: 'zh', net: [], cpu: [], ram: [] };
    if (!I18N[state.lang]) state.lang = 'zh';
    function t(key) { const dict = I18N[state.lang] || I18N.zh; return dict[key] || I18N.zh[key] || key; }
    function applyLang() {
      document.querySelectorAll('[data-i18n]').forEach(node => { const key = node.getAttribute('data-i18n'); if (key) node.textContent = t(key); });
      document.querySelectorAll('[data-i18n-attr]').forEach(node => { const key = node.getAttribute('data-i18n-attr'); if (key) node.textContent = t(key); });
    }
    applyLang();
    const themeSelect = document.getElementById('theme');
    const accentInput = document.getElementById('accent');
    const langSelect = document.getElementById('lang');
    const diskDetail = document.getElementById('diskDetail');
    themeSelect.value = state.theme || 'dark';
    accentInput.value = state.accent || '#4da3ff';
    langSelect.value = state.lang || 'zh';
    applyTheme();
    vscode.postMessage({ type: 'ready' });
    document.getElementById('cleanGpu').addEventListener('click', event => { event.currentTarget.disabled = true; setActionStatus(t('actionStatus').replace('%s', t('cleanGpu'))); vscode.postMessage({ type: 'cleanGpu' }); });
    document.getElementById('cleanCpu').addEventListener('click', event => { event.currentTarget.disabled = true; setActionStatus(t('actionStatus').replace('%s', t('cleanCpu'))); vscode.postMessage({ type: 'cleanCpu' }); });
    document.getElementById('processList').addEventListener('click', event => {
      const button = event.target && event.target.closest ? event.target.closest('button[data-pid]') : undefined;
      if (!button) return;
      const pid = Number(button.dataset.pid);
      if (pid) {
        button.disabled = true;
        button.textContent = 'killing';
        setActionStatus(t('killStatus').replace('%s', String(pid)));
        vscode.postMessage({ type: 'killProcess', pid });
      }
    });
    document.getElementById('storageCard').addEventListener('click', () => switchPage('storagePage'));
    document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => switchPage(tab.dataset.page)));
    langSelect.addEventListener('change', () => { state.lang = langSelect.value; applyLang(); saveState(); });
    themeSelect.addEventListener('change', () => { state.theme = themeSelect.value; applyTheme(); saveState(); drawPercentChart('cpuChart', state.cpu, state.accent || '#4da3ff'); drawPercentChart('ramChart', state.ram, state.accent || '#4da3ff'); drawNetwork(); });
    accentInput.addEventListener('input', () => { state.accent = accentInput.value; applyTheme(); saveState(); drawPercentChart('cpuChart', state.cpu, state.accent || '#4da3ff'); drawPercentChart('ramChart', state.ram, state.accent || '#4da3ff'); drawNetwork(); });
    window.addEventListener('message', event => {
      if (event.data.type === 'error') { setText('platform', '采集失败：' + event.data.message); setActionStatus('操作失败：' + event.data.message); return; }
      if (event.data.type === 'action') { setActionStatus(event.data.message); return; }
      render(event.data.stats);
    });
    function render(stats) {
      setText('host', stats.hostname); setText('platform', stats.platform);
      setGauge('cpuGauge', 'cpu', stats.cpuPercent, 0); setText('load', stats.loadAverage.map(v => v.toFixed(2)).join(' / ')); setText('uptime', formatDuration(stats.uptime));
      setGauge('memoryGauge', 'memory', stats.memory.percent, 0); setText('memoryText', formatBytes(stats.memory.used) + ' / ' + formatBytes(stats.memory.total)); setText('memoryFree', formatBytes(stats.memory.free));
      if (stats.storage) { setStorageStrip(stats.storage.percent); setText('storageMount', t('viewDetails')); setText('storageText', stats.storage.used + ' / ' + stats.storage.size); }
      renderDisks(stats.disks || []);
      setText('rxRate', formatBytes(stats.network.receiveRate) + '/s'); setText('txRate', formatBytes(stats.network.transmitRate) + '/s'); setText('rxTotal', formatBytes(stats.network.received)); setText('txTotal', formatBytes(stats.network.transmitted));
      renderSsh(stats.ssh || []);
      renderProcesses(stats.processes || []);
      document.getElementById('cleanGpu').disabled = false; document.getElementById('cleanCpu').disabled = false;
      pushPercent('cpu', stats.cpuPercent); pushPercent('ram', stats.memory.percent); drawPercentChart('cpuChart', state.cpu, state.accent || '#4da3ff'); drawPercentChart('ramChart', state.ram, state.accent || '#4da3ff');
      pushNetwork(stats.network.receiveRate, stats.network.transmitRate); drawNetwork(); renderGpus(stats.gpus || []);
    }
    function renderDisks(disks) {
      setText('diskCount', disks.length ? t('disksLabel').replace('%d', String(disks.length)) : '0 ' + t('storage').toLowerCase());
      diskDetail.innerHTML = disks.length ? '<div class="disk-list">' + disks.map(d => '<div class="disk-row"><div class="disk-row-head"><span title="' + escapeHtml(d.mount) + '">' + escapeHtml(d.mount) + '</span><span>' + Number(d.percent).toFixed(2) + '%</span></div><div class="meter"><div class="meter-fill" style="width:' + safePercent(d.percent) + '%;background:' + percentColor(d.percent) + '"></div><div class="meter-label">' + d.used + ' / ' + d.size + '</div></div><div class="disk-row-foot">' + t('storageUsed').replace('%s', d.available).replace('%s', escapeHtml(d.filesystem)) + '</div></div>').join('') + '</div>' : '<div class="muted">' + t('disksEmpty') + '</div>';
    }
    function switchPage(pageId) {
      document.querySelectorAll('.page').forEach(page => page.classList.toggle('active', page.id === pageId));
      document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.page === pageId));
    }
    function renderProcesses(processes) {
      setText('processCount', processes.length ? t('processesLabel').replace('%d', String(processes.length)) : t('processesLabelZero'));
      const list = document.getElementById('processList');
      if (!processes.length) { list.innerHTML = '<div class="muted">' + t('processesEmpty') + '</div>'; return; }
      const header = '<div class="process-row header-row"><span>' + t('actionCol') + '</span><span></span><span>' + t('pid') + '</span><span>' + t('cpuCol') + '</span><span>' + t('memCol') + '</span><span>' + t('cmd') + '</span></div>';
      const rows = processes.map(process => '<div class="process-row"><button class="danger small" data-pid="' + escapeHtml(process.pid) + '">' + t('kill') + '</button><span class="gpu-led ' + processStatusClass(process) + '" title="' + processStatusText(process) + '"></span><span>' + escapeHtml(process.pid) + '</span><span>' + Number(process.cpu || 0).toFixed(1) + '%</span><span>' + Number(process.memory || 0).toFixed(1) + '%</span><span class="cmd" title="' + escapeHtml(process.command || process.name || '') + '">' + escapeHtml(process.command || process.name || '--') + '</span></div>').join('');
      list.innerHTML = header + rows;
    }
    function renderSsh(items) {
      setText('sshCount', items.length ? t('sshLabel').replace('%d', String(items.length)) : t('sshLabelZero'));
      const list = document.getElementById('sshList');
      if (!items.length) { list.innerHTML = '<div class="muted">' + t('sshEmpty') + '</div>'; return; }
      list.innerHTML = items.map(item => '<div class="row"><span>' + escapeHtml(item.remote) + '</span><span class="chip">' + escapeHtml(item.state) + ' · ' + escapeHtml(item.direction) + '</span></div>').join('');
    }
    function renderGpus(gpus) {
      setText('gpuCount', gpus.length ? t('gpusLabel').replace('%d', String(gpus.length)) : t('gpusLabelZero'));
      const grid = document.getElementById('gpuGrid');
      if (!gpus.length) { grid.innerHTML = '<div class="muted">' + t('gpuEmpty') + '</div>'; return; }
      grid.innerHTML = gpus.map(gpu => '<div class="card"><div class="card-title"><span>GPU ' + gpu.index + '</span><span class="gpu-title-right"><span class="muted">' + escapeHtml(gpu.name) + '</span><span class="gpu-led ' + gpuStatusClass(gpu) + '" title="' + gpuStatusText(gpu) + '"></span></span></div><div class="gauge" style="--percent:' + safePercent(gpu.utilization) + '"><div class="gauge-value">' + gpu.utilization.toFixed(0) + '%</div></div><div class="stats"><div class="row"><span>' + t('memCol') + '</span><span>' + gpu.memoryPercent.toFixed(0) + '%</span></div><div class="meter"><div class="meter-fill" style="width:' + safePercent(gpu.memoryPercent) + '%;background:' + percentColor(gpu.memoryPercent) + '"></div><div class="meter-label">' + gpu.memoryUsed + ' / ' + gpu.memoryTotal + ' MB</div></div><div class="row"><span>°C</span><span>' + gpu.temperature + '</span></div><div class="row"><span>W</span><span>' + formatPower(gpu) + '</span></div></div></div>').join('');
    }
    function pushNetwork(rx, tx) { state.net = (state.net || []).concat([{ rx, tx }]).slice(-60); saveState(); }
    function pushPercent(key, value) { state[key] = (state[key] || []).concat([safePercent(value)]).slice(-60); saveState(); }
    function drawPercentChart(canvasId, values, color) {
      const canvas = document.getElementById(canvasId); const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--border'); ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) { const y = i * canvas.height / 4; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }
      drawLineOnCanvas(canvas, values || [], 100, color);
    }
    function drawNetwork() {
      const canvas = document.getElementById('netChart'); const ctx = canvas.getContext('2d'); const points = state.net || [];
      ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--border'); ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) { const y = i * canvas.height / 4; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }
      const max = Math.max(1, ...points.flatMap(p => [p.rx, p.tx])); drawLineOnCanvas(canvas, points.map(p => p.rx), max, state.accent || '#4da3ff'); drawLineOnCanvas(canvas, points.map(p => p.tx), max, '#ffbd2e');
    }
    function drawLineOnCanvas(canvas, values, max, color) { const ctx = canvas.getContext('2d'); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); values.forEach((v, i) => { const x = values.length <= 1 ? 0 : i * canvas.width / (values.length - 1); const y = canvas.height - (v / max) * (canvas.height - 12) - 6; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); }
    function updateDiskOpen() { diskDetail.classList.toggle('open', !!state.storageOpen); setText('storageMount', state.storageOpen ? '点击收起' : '点击展开'); }
    function applyTheme() { document.body.className = 'theme-' + (state.theme || 'dark'); document.documentElement.style.setProperty('--accent', state.accent || '#4da3ff'); }
    function saveState() { vscode.setState(state); }
    function setGauge(gaugeId, valueId, percent, digits = 0) { const safe = safePercent(percent); document.getElementById(gaugeId).style.setProperty('--percent', safe); setText(valueId, safe.toFixed(digits) + '%'); }
    function setStorageStrip(percent) { const safe = safePercent(percent); document.getElementById('storageFill').style.width = safe + '%'; document.getElementById('storageFill').style.background = percentColor(safe); setText('storage', safe.toFixed(2) + '%'); }
    function safePercent(value) { return Math.max(0, Math.min(100, Number(value) || 0)); }
    function percentColor(value) { const p = safePercent(value); return p >= 85 ? 'var(--danger)' : p >= 65 ? 'var(--warn)' : 'var(--ok)'; }
    function gpuStatusClass(gpu) { return gpu.temperature >= 80 || gpu.memoryPercent >= 90 ? 'danger' : (gpu.utilization >= 60 || gpu.memoryPercent >= 60 ? 'warn' : 'ok'); }
    function gpuStatusText(gpu) { return gpuStatusClass(gpu) === 'danger' ? '高负载/高温' : (gpuStatusClass(gpu) === 'warn' ? '使用中' : '空闲/正常'); }
    function processStatusClass(process) { return process.cpu >= 80 || process.memory >= 80 ? 'danger' : (process.cpu >= 30 || process.memory >= 30 ? 'warn' : 'ok'); }
    function processStatusText(process) { return processStatusClass(process) === 'danger' ? '高占用' : (processStatusClass(process) === 'warn' ? '活跃' : '正常'); }
    function formatPower(gpu) { return gpu.powerDraw == null || gpu.powerLimit == null ? '--' : gpu.powerDraw.toFixed(1) + ' / ' + gpu.powerLimit.toFixed(1) + ' W'; }
    function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
    function setActionStatus(text) { setText('actionStatus', text); }
    function formatBytes(value) { const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let index = 0; while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; } return value.toFixed(index === 0 ? 0 : 1) + ' ' + units[index]; }
    function formatDuration(seconds) { const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600); const minutes = Math.floor((seconds % 3600) / 60); return days + '天 ' + hours + '小时 ' + minutes + '分'; }
    function escapeHtml(value) { return String(value).replace(/[&<>\"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[char])); }
  </script>
</body>
</html>`;
  }
}

function activate(context) {
  const provider = new SystemMonitorProvider();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('systemMonitor.view', provider), vscode.commands.registerCommand('systemMonitor.refresh', () => provider.refresh()));
}

function deactivate() { }

async function killPid(pid) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`非法 PID: ${pid}`);
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    await execFileAsync('kill', ['-9', String(pid)]);
  }
}

async function collectStats(previousCpu, previousNetwork) {
  const currentCpu = getCpuSnapshot();
  const idleDiff = currentCpu.idle - previousCpu.idle;
  const totalDiff = currentCpu.total - previousCpu.total;
  const cpuPercent = totalDiff > 0 ? (1 - idleDiff / totalDiff) * 100 : 0;
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const currentNetwork = getNetworkSnapshot();
  const elapsedSeconds = Math.max((currentNetwork.timestamp - previousNetwork.timestamp) / 1000, 1);
  const disks = await getDiskStats();
  return {
    cpuPercent,
    memory: { total: totalMemory, used: usedMemory, free: freeMemory, percent: totalMemory > 0 ? (usedMemory / totalMemory) * 100 : 0 },
    storage: disks[0],
    disks,
    network: { received: currentNetwork.received, transmitted: currentNetwork.transmitted, receiveRate: Math.max(0, (currentNetwork.received - previousNetwork.received) / elapsedSeconds), transmitRate: Math.max(0, (currentNetwork.transmitted - previousNetwork.transmitted) / elapsedSeconds) },
    ssh: getSshConnections(),
    processes: await getProcesses(),
    gpus: await getGpuStats(),
    loadAverage: os.loadavg(),
    uptime: os.uptime(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    hostname: os.hostname()
  };
}

function getCpuSnapshot() {
  return os.cpus().reduce((snapshot, cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    snapshot.idle += cpu.times.idle;
    snapshot.total += total;
    return snapshot;
  }, { idle: 0, total: 0 });
}

async function getDiskStats() {
  try {
    const { stdout } = await execFileAsync('df', ['-B1', '-x', 'tmpfs', '-x', 'devtmpfs']);
    return stdout.trim().split('\n').slice(1).map(line => {
      const values = line.trim().split(/\s+/);
      if (values.length < 6) return undefined;
      const size = Number(values[1]) || 0;
      const used = Number(values[2]) || 0;
      const available = Number(values[3]) || 0;
      return { filesystem: values[0], size: formatDiskBytes(size), used: formatDiskBytes(used), available: formatDiskBytes(available), percent: size > 0 ? Number(((used / size) * 100).toFixed(2)) : 0, mount: values.slice(5).join(' ') };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function formatDiskBytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return value.toFixed(2) + ' ' + units[index];
}

function getNetworkSnapshot() {
  try {
    return fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2).reduce((total, line) => {
      const [namePart, dataPart] = line.split(':');
      if (!namePart || !dataPart || namePart.trim() === 'lo') return total;
      const values = dataPart.trim().split(/\s+/).map(Number);
      total.received += values[0] || 0;
      total.transmitted += values[8] || 0;
      return total;
    }, { received: 0, transmitted: 0, timestamp: Date.now() });
  } catch {
    return { received: 0, transmitted: 0, timestamp: Date.now() };
  }
}

function getSshConnections() {
  try {
    return fs.readFileSync('/proc/net/tcp', 'utf8').split('\n').slice(1).concat(fs.existsSync('/proc/net/tcp6') ? fs.readFileSync('/proc/net/tcp6', 'utf8').split('\n').slice(1) : []).map(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) return undefined;
      const local = parseAddress(parts[1]);
      const remote = parseAddress(parts[2]);
      const state = tcpState(parts[3]);
      if (!local || !remote) return undefined;
      if (local.port !== 22 && remote.port !== 22) return undefined;
      return { remote: remote.host + ':' + remote.port, state, direction: local.port === 22 ? '入站' : '出站' };
    }).filter(Boolean).slice(0, 20);
  } catch {
    return [];
  }
}

function parseAddress(value) {
  const [hostHex, portHex] = value.split(':');
  const port = parseInt(portHex, 16);
  if (hostHex.length === 8) {
    const bytes = hostHex.match(/../g).reverse().map(part => parseInt(part, 16));
    return { host: bytes.join('.'), port };
  }
  return { host: hostHex, port };
}

function tcpState(value) {
  return ({ '01': 'ESTABLISHED', '02': 'SYN_SENT', '03': 'SYN_RECV', '04': 'FIN_WAIT1', '05': 'FIN_WAIT2', '06': 'TIME_WAIT', '07': 'CLOSE', '08': 'CLOSE_WAIT', '09': 'LAST_ACK', '0A': 'LISTEN', '0B': 'CLOSING' })[value] || value;
}

async function getProcesses() {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,pcpu,pmem,comm,args', '--sort=-pcpu']);
    return stdout.trim().split('\n').slice(1, 81).map(line => {
      const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s*(.*)$/);
      if (!match) return undefined;
      return { pid: Number(match[1]), cpu: Number(match[2]) || 0, memory: Number(match[3]) || 0, name: match[4], command: match[5] || match[4] };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

async function getGpuProcessIds() {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', ['--query-compute-apps=pid', '--format=csv,noheader,nounits']);
    return [...new Set(stdout.split(/\r?\n/).map(line => line.trim()).filter(line => /^\d+$/.test(line)).map(line => Number(line)).filter(pid => Number.isInteger(pid) && pid > 1))];
  } catch {
    return [];
  }
}

async function getGpuStats() {
  try {
    const fields = ['index', 'name', 'utilization.gpu', 'memory.used', 'memory.total', 'temperature.gpu', 'power.draw', 'power.limit'].join(',');
    const { stdout } = await execFileAsync('nvidia-smi', [`--query-gpu=${fields}`, '--format=csv,noheader,nounits']);
    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [index, name, utilization, memoryUsed, memoryTotal, temperature, powerDraw, powerLimit] = line.split(',').map(value => value.trim());
      const used = Number(memoryUsed) || 0;
      const total = Number(memoryTotal) || 0;
      return { index: Number(index) || 0, name, utilization: Number(utilization) || 0, memoryUsed: used, memoryTotal: total, memoryPercent: total > 0 ? (used / total) * 100 : 0, temperature: Number(temperature) || 0, powerDraw: parseOptionalNumber(powerDraw), powerLimit: parseOptionalNumber(powerLimit) };
    });
  } catch {
    return [];
  }
}

function parseOptionalNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}

module.exports = { activate, deactivate };
