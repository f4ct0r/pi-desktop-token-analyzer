# Token Analyzer

分析 PI-Desktop 的 token 用量。右侧面板底部常驻一条紧凑用量条（今日 / 近 7 天 / 近 30 天 / 总计），点击后就地展开成完整 dashboard。

## 功能

**总量与时间窗口**

- 总用量、近 7 天、近 30 天、今日四个口径
- 近 30 天每日柱状图（本地时区按天分桶，无数据的天是真实的 0 而不是缺口）
- 总用量 = 输入 + 输出 + 缓存读 + 缓存写（可在设置里关掉缓存项）

**每模型用量**

- 按 `providerId/modelId` 聚合，含总用量、输入、输出、缓存、占比
- 超出显示条数的模型折叠成一行「其余 N 个模型」，保证占比列加起来是 100%
- 另有「按项目」和「用量最高的会话」两张表
- 表格里的 token 数用 `K`/`M`/`B` 缩写，悬停显示精确数量

**悬停提示**

- 近 30 天柱状图：悬停任意一天显示当天总用量、输入 / 输出 / 缓存 / 推理、轮次
- 三张表的 token 列：单元格是缩写值，悬停显示精确数量
- 整列柱高都是命中区域，所以用量很小的一天也一样好悬停

**侧边栏常驻显示**

- 底部常驻紧凑条，两种模式：`compact`（只有条）和 `expanded`（条 + dashboard）
- 点击条 / dashboard 的收起按钮 / `Esc` 互相切换，选择记在插件自己的分区 `localStorage` 里
- 每轮对话结束（`session:turnEnded`）后自动防抖刷新，缓存 20 秒
- 跟随宿主的浅色 / 深色主题和插件主题

## 安装

在 PI-Desktop 中：**扩展（Extensions）→ 已安装（Installed）→ 加载开发插件**，选择本目录。

首次加载会请求四个权限：

| 权限 | 用途 |
|---|---|
| `ui.view` | 把 view 停靠在右侧 work panel |
| `usage.read` | 读取每轮 token 计数（只读计数器与 id，不含任何消息正文） |
| `models.list` | 把 `modelId` 解析成可读模型名 |
| `desktop.control` | 只调用只读操作 `project/list`，把 `projectId` 解析成项目名 |

`desktop.control` 仅用于「按项目」表显示真实项目名：它只发起 risk 为 `read` 的 `project/list`（枚举项目目录），不调用任何写操作、不需要用户二次确认。拒绝该权限或宿主没有控制面时，插件降级为显示 `项目 #<id>`，其余统计不受影响。

`usage.read` 是唯一必需的功能性权限。宿主只提供**已结束**轮次的扁平事实行（每页 ≤ 500 行、窗口 ≤ 365 天、keyset 游标分页），所有 dashboard 形状都是插件自己算的——这是规范刻意的设计（[spec 07-plugins/03 §usage](../../PI-Desktop/docs/spec/07-plugins/03-plugin-api.md)）。

## 设置

在 **扩展 → 本插件 → 设置** 中：

| 键 | 默认 | 说明 |
|---|---|---|
| `scope` | `global` | `global` = 全部项目累计；`project` = 仅当前项目 |
| `includeCache` | `true` | 总用量是否计入缓存读 + 缓存写 |
| `topModels` | `8` | 每模型 / 每会话表格最多显示多少行 |

## 架构

```
main.js              插件入口：注册命令、实现 onPanelInvoke 数据桥
lib/aggregate.js     纯聚合：窗口分桶、每模型/每项目/每会话分组、占比
lib/usage-store.js   分页拉取 + 20s 缓存 + 并发折叠
views/usage.html     两段式界面：底部紧凑条 + 可展开的 dashboard
views/usage.js       渲染；通过 pluginBridge 向 main.js 要聚合结果
views/usage.css      主题跟随宿主的浅色 / 深色变量
```

**为什么 view 不直接读数据**：插件页面没有 `pi` 对象，只能用 `window.pluginBridge`；而宿主固定的 panel 通道白名单里没有 `usage.*`。规范允许宿主把自己不实现的通道转发给插件的 `onPanelInvoke`，所以 view 通过 `token-usage.summary` 向插件进程要**已经聚合好的结果**。原始的每轮事实行因此留在插件进程里，不会每次刷新都往页面搬几千行。

**数据流**

```
pi.usage.listTurns (宿主)
  └─ lib/usage-store.js   分页 / 缓存 / 并发折叠
       └─ lib/aggregate.js  纯聚合，可单测
            └─ main.js onPanelInvoke  ← token-usage.summary
                 └─ views/usage.js  渲染
```

## 关于两个 API 限制

这两点是宿主当前 API 的边界，插件在界面上如实标注而不是假装没有：

1. **没有「侧边栏常驻状态条」扩展点。** 插件唯一能进右侧面板的面是 `contributes.views`，它会成为 work panel 的一个 **tab**。所以本插件做成两段式：tab 的静止状态就是那条底部紧凑条，点开才占满面板。要做到「面板关闭时也常驻显示」，需要宿主新增一个扩展点。
2. **项目筛选只能用数字 id，项目名要走另一条路。** `pi.usage.listTurns` 按 `sessions.project_id`（数字）过滤，行里既没有项目名也没有路径；`pi.workspace.get()` 只返回当前可见工作区的 `{path,name}`，既不是全量列表也不带数字 id，帮不上映射。插件改用 `pi.desktop.invoke({operation:'project/list'})`（需 `desktop.control`，risk 为 `read`）拿项目目录，它的 `id` 就是那个数字 `project_id`，所以是一次普通的 map 关联。该权限被拒、宿主没有控制面、或项目在其最后一次会话之后被删除时，「按项目」表回退显示 `项目 #<数字 id>`。

## 测试

```bash
node --test "test/*.test.js"
```

38 个用例，覆盖聚合口径（窗口边界、缓存与 reasoning 不重复计数、每日序列稠密度、占比求和、畸形行、空窗口）与数据层（分页、行数预算、窗口钳制、缓存与 `invalidate()` 竞态、项目范围隔离、模型名与项目名解析及其降级）。

聚合逻辑是纯函数，不依赖 `pi` 或 DOM，所以这些测试在插件宿主之外也能跑。

## 打包

```bash
cd PI-Desktop && pnpm pi-plugin pack /path/to/pi-desktop-token-analyzer
```

`pi-plugin check` 当前结果：0 error、0 warning。
