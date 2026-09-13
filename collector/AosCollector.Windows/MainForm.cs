using AosCollector.Core;
using System.Text.Json;
using System.ServiceProcess;

namespace AosCollector.Windows;

internal sealed class MainForm : Form
{
  private readonly TextBox deviceName = new() { Width = 220 };
  private readonly TextBox serverUrl = new() { Width = 430 };
  private readonly TextBox credential = new() { Width = 430, UseSystemPasswordChar = true };
  private readonly ComboBox encoding = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 130 };
  private readonly DataGridView directoryTable = Grid();
  private readonly DataGridView fileTable = Grid();
  private readonly Label overview = new() { AutoSize = false, Height = 185, Dock = DockStyle.Top, Padding = new Padding(16) };
  private readonly Label message = new() { AutoSize = true, ForeColor = Color.Firebrick, Padding = new Padding(12) };
  private readonly NotifyIcon tray;
  private readonly System.Windows.Forms.Timer timer = new() { Interval = 2000 };
  private readonly List<DirectoryConfig> directories = [];
  private readonly List<Button> buttons = [];
  private string deviceId = "";
  private bool busy;
  private bool updating;
  private bool exiting;
  protected override void WndProc(ref Message message)
  {
    if (message.Msg == 0x8000 + 427) {
      if (!busy) { exiting = true; BeginInvoke(() => Close()); }
      return;
    }
    base.WndProc(ref message);
  }
  public MainForm(bool startInTray)
  {
    Text = "Apple 订单 · AOS 采集器"; Width = 1020; Height = 760; MinimumSize = new Size(850, 650); BackColor = Color.FromArgb(249, 250, 251); Font = new Font("Microsoft YaHei UI", 9); StartPosition = FormStartPosition.CenterScreen;
    var tabs = new TabControl { Dock = DockStyle.Fill }; var statusTab = new TabPage("运行状态"); var configTab = new TabPage("采集配置");
    var statusButtons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 52, Padding = new Padding(8) };
    statusButtons.Controls.Add(Action("立即扫描", async () => { await ServiceClient.Call(new { command = "scan" }); }));
    statusButtons.Controls.Add(Action("重试连接与上传", async () => { await ServiceClient.Call(new { command = "retry" }); }));
    statusButtons.Controls.Add(Action("启动服务", () => Task.Run(() => Installer.SetRunning(true))));
    statusButtons.Controls.Add(Action("停止服务", async () => { if (MessageBox.Show("停止后将暂停本机采集，待发送队列保留。是否停止？", "停止采集服务", MessageBoxButtons.YesNo) == DialogResult.Yes) await Task.Run(() => Installer.SetRunning(false)); }));
    statusButtons.Controls.Add(Action("导出脱敏诊断", ExportDiagnostics));
    statusTab.Controls.Add(fileTable); statusTab.Controls.Add(overview); statusTab.Controls.Add(statusButtons);
    fileTable.Columns.Add("directory", "目录名称"); fileTable.Columns.Add("file", "文件名"); fileTable.Columns.Add("records", "已识别记录"); fileTable.Columns.Add("tail", "未完成尾行"); fileTable.Columns.Add("error", "读取状态");
    var form = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2, Padding = new Padding(16) };
    form.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150)); form.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
    AddField(form, "本机设备名称", deviceName); AddField(form, "服务器 HTTPS 地址", serverUrl); AddField(form, "设备接入凭证", credential);
    encoding.Items.AddRange(["utf-8", "gb18030"]); encoding.SelectedIndex = 0; AddField(form, "文件编码", encoding);
    var hint = new Label { AutoSize = true, Text = "凭证留空时保留现有凭证。目录仅在本机配置。全局来源在网页后台切换。", Padding = new Padding(0, 8, 0, 8) }; form.Controls.Add(hint); form.SetColumnSpan(hint, 2);
    directoryTable.Columns.Add("label", "目录名称"); directoryTable.Columns.Add("path", "本机路径");
    var configButtons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 100, Padding = new Padding(8), AutoScroll = true };
    configButtons.Controls.Add(Action("添加目录", AddDirectory));
    configButtons.Controls.Add(Action("移除所选目录", () => { if (directoryTable.CurrentRow != null) { directories.RemoveAt(directoryTable.CurrentRow.Index); ShowDirectories(); } return Task.CompletedTask; }));
    configButtons.Controls.Add(Action("测试连接与目录权限", async () => { await ServiceClient.Call(new { command = "test", config = Candidate() }); message.Text = "连接成功，后台服务可读取所选目录；未提交真实订单。"; }));
    configButtons.Controls.Add(Action("保存配置", async () => { await ServiceClient.Call(new { command = "save", config = Candidate() }); credential.Clear(); message.Text = "配置已保存，后台采集已开始。"; }));
    configButtons.Controls.Add(message); configTab.Controls.Add(directoryTable); configTab.Controls.Add(form); configTab.Controls.Add(configButtons);
    tabs.TabPages.Add(statusTab); tabs.TabPages.Add(configTab); Controls.Add(tabs);
    tray = new NotifyIcon { Text = "AOS 采集器 · 等待状态", Icon = SystemIcons.Application, Visible = true };
    var menu = new ContextMenuStrip(); menu.Items.Add("打开配置窗口", null, (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); });
    menu.Items.Add("退出托盘（后台服务继续）", null, (_, _) => { exiting = true; Close(); }); tray.ContextMenuStrip = menu;
    tray.DoubleClick += (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); };
    FormClosing += (_, e) => { if (!exiting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); } };
    FormClosed += (_, _) => { timer.Stop(); tray.Dispose(); timer.Dispose(); };
    Shown += async (_, _) => { await LoadConfig(); await RefreshStatus(); if (startInTray) Hide(); };
    timer.Tick += async (_, _) => await RefreshStatus(); timer.Start();
  }
  private static DataGridView Grid() => new() { Dock = DockStyle.Fill, BackgroundColor = Color.White, AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill, ReadOnly = true, AllowUserToAddRows = false, AllowUserToDeleteRows = false, RowHeadersVisible = false, SelectionMode = DataGridViewSelectionMode.FullRowSelect, MultiSelect = false };
  private static void AddField(TableLayoutPanel panel, string label, Control control) { panel.RowCount++; panel.Controls.Add(new Label { Text = label, AutoSize = true, Padding = new Padding(0, 7, 0, 7) }, 0, panel.RowCount - 1); panel.Controls.Add(control, 1, panel.RowCount - 1); }
  private Button Action(string text, Func<Task> work)
  {
    var button = new Button { Text = text, AutoSize = true, Height = 32, Padding = new Padding(8, 2, 8, 2) }; buttons.Add(button);
    button.Click += async (_, _) => {
      if (busy) return; busy = true; foreach (var b in buttons) b.Enabled = false; message.Text = "正在处理…";
      try { await work(); if (message.Text == "正在处理…") message.Text = "操作完成。"; }
      catch (CollectorException e) { message.Text = ErrorText(e.Code); MessageBox.Show(message.Text, "AOS 采集器"); }
      catch (Exception) { message.Text = "操作未完成，请检查服务、目录和网络。队列保留。"; }
      finally { busy = false; foreach (var b in buttons) b.Enabled = true; }
    }; return button;
  }
  private CollectorConfig Candidate() => new(deviceName.Text.Trim(), serverUrl.Text.Trim(), credential.Text, deviceId, [.. directories], encoding.SelectedItem?.ToString() ?? "utf-8");
  private Task AddDirectory()
  {
    if (directories.Count >= 20) { message.Text = "最多配置 20 个目录。"; return Task.CompletedTask; }
    using var dialog = new FolderBrowserDialog { Description = "选择 AOS 订单文件所在的本机目录", UseDescriptionForTitle = true };
    if (dialog.ShowDialog() == DialogResult.OK && !directories.Any(d => StringComparer.OrdinalIgnoreCase.Equals(d.Path, dialog.SelectedPath))) {
      directories.Add(new(Guid.NewGuid().ToString(), $"采集目录 {directories.Count + 1}", dialog.SelectedPath)); ShowDirectories();
    }
    return Task.CompletedTask;
  }
  private void ShowDirectories() { directoryTable.Rows.Clear(); foreach (var d in directories) directoryTable.Rows.Add(d.Label, d.Path); }
  private async Task LoadConfig()
  {
    try {
      var c = await ServiceClient.Call(new { command = "config" }); deviceName.Text = c.GetProperty("deviceName").GetString(); serverUrl.Text = c.GetProperty("serverUrl").GetString(); deviceId = c.GetProperty("deviceId").GetString() ?? "";
      credential.PlaceholderText = c.GetProperty("credentialConfigured").GetBoolean() ? "已配置，留空保留" : "从网页设备登记页面复制";
      directories.Clear(); directories.AddRange(c.GetProperty("directories").Deserialize<List<DirectoryConfig>>(Protocol.Json) ?? []); ShowDirectories(); encoding.SelectedItem = c.GetProperty("encoding").GetString();
    } catch (Exception) { message.Text = "服务未就绪，请先启动服务。"; }
  }
  private async Task RefreshStatus()
  {
    if (updating || busy || IsDisposed) return; updating = true;
    try {
      var result = await ServiceClient.Call(new { command = "status" }); var status = result.Deserialize<CollectorStatus>(Protocol.Json)!;
      if (IsDisposed) return;
      var source = status.ActiveSource == "aos" ? "AOS 文件" : status.ActiveSource == "email" ? "邮件模式，AOS 暂停入库" : "尚未取得来源设置";
      overview.Text = $"后台服务：{status.ServiceState}　服务器：{status.ConnectionState}\n当前来源：{source}\n本地待上传：{status.Counts.PendingUpload}　上传异常：{status.Counts.UploadError}　今日发现：{status.Counts.TodayDiscovered}\n最近成功扫描：{status.LastScanAt ?? "尚未扫描"}　状态更新时间：{status.UpdatedAt}";
      overview.Text += status.ServerCounts is { } totals ? $"\n服务器累计已入库：{totals.Created}　重复：{totals.Duplicate}　待人工：{totals.ManualReview}　暂停：{totals.Paused}　今日接收：{totals.TodayReceived}" : "\n服务器处理结果：尚未取得";
      overview.Text += $"\n付款码待上传：{status.PendingPaymentCodes}　付款码异常：{status.PaymentCodeErrors}　版本：{status.AgentVersion}";
      overview.Text += $"\n服务器计数上次同步：{status.ServerSyncedAt ?? "尚未同步"}";
      tray.Text = "AOS 采集器 · " + (status.ErrorCode == null ? source : ErrorText(status.ErrorCode)[..Math.Min(30, ErrorText(status.ErrorCode).Length)]);
      tray.Icon = status.ErrorCode == null ? SystemIcons.Information : SystemIcons.Warning;
      fileTable.Rows.Clear();
      foreach (var dir in status.Directories.Where(d => !status.Files.Any(f => f.Directory == d.Label))) fileTable.Rows.Add(dir.Label, "—", 0, "—", dir.ErrorCode == null ? "等待当天文件" : ErrorText(dir.ErrorCode));
      foreach (var file in status.Files) fileTable.Rows.Add(file.Directory, file.FileName, file.Records, file.PendingTail ? "等待写完" : "无", file.ErrorCode != null ? ErrorText(file.ErrorCode) : file.WarningCode == "FILE_NAME_DATE_MISMATCH" ? "文件名日期不同，已按行内日期核对" : "正常");
    } catch (Exception) { if (!IsDisposed) { overview.Text = "无法读取后台服务状态。请检查服务是否已启动。上次传输结果可能已过期。"; tray.Text = "AOS 采集器 · 服务不可用"; tray.Icon = SystemIcons.Warning; } }
    finally { updating = false; }
  }
  private async Task ExportDiagnostics()
  {
    try {
      var status = await ServiceClient.Call(new { command = "status" });
      using var dialog = new SaveFileDialog { FileName = "AOS采集器脱敏诊断.json", Filter = "JSON 文件|*.json" };
      if (dialog.ShowDialog() == DialogResult.OK) await File.WriteAllTextAsync(dialog.FileName, JsonSerializer.Serialize(status, new JsonSerializerOptions { WriteIndented = true }));
    } catch (Exception) { throw new CollectorException("DIAGNOSTIC_FAILED"); }
  }
  private static string ErrorText(string code) => code switch {
    "SERVICE_NOT_AVAILABLE" => "后台服务不可用，请启动服务后重试。", "DEVICE_UNAUTHORIZED" => "设备凭证失效，请更新凭证。", "DEVICE_DISABLED" => "设备已被网页管理员禁用。",
    "SERVICE_DIRECTORY_UNREADABLE" => "后台服务无法读取目录，请选择服务可读取的本机目录。", "PENDING_QUEUE_IDENTITY_CHANGE" => "本机队列已有历史记录，不能更换服务器或设备身份；请使用原设备凭证。",
    "CONNECTION_FAILED" => "连接失败，请检查网络和 HTTPS 地址。", "SERVER_URL_INVALID" => "请输入根 HTTPS 服务地址，不含路径、账号或查询参数。",
    "ENCODING_INVALID" => "文件编码不匹配，请核实后在配置页选择编码。", "DIRECTORY_MISSING" => "配置目录不存在。", "FILE_READ_FAILED" => "文件暂时无法读取，将自动重试。",
    "RATE_LIMITED" => "服务器限流，等待自动重试。", "CONFIG_INVALID" => "设备名称、目录或编码配置无效。", _ => "采集异常：" + code
  };
}
