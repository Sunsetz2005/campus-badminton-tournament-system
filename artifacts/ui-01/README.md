# UI-01 界面核验证据

本目录记录 UI-01“亚运会网站参考与羽毛球公开端改造”的只读核验证据。三类图片用途不同，不能互相替代。

## `reference-site/`

来源：`https://results.asiangames2026.org/#/schedule/daily/2026-09-21`

- 核验时间：2026-09-20 09:34:56 +08 起。
- 环境：本机 Playwright Chromium；浏览器上下文 `timezoneId=Asia/Shanghai`。
- `schedule-badminton-*`：展开 Badminton 后的实际公开赛程；覆盖 1440×900、1024×900、768×900、390×844、375×812。
- `filters-1440x900.png`：桌面实际筛选面板。
- `filters-basic-375x812.png`：手机筛选面板展开、尚未展开高级筛选。
- `filters-advanced-375x812.png`：手机高级筛选展开后的状态。
- `match-detail-1440x900.png`、`match-detail-390x844.png`：实际进入首场羽毛球团体赛详情的 Start list。
- `match-detail-results-1440x900.png`：实际点击 Results 后的 Tie、Match、Periods 和 Match Stats 结构。
- `match-detail-reports-1440x900.png`：实际点击 Reports 后的 C75A PDF 条目；本轮未打开或下载 PDF。
- 上述仅是浏览器模拟视口，不是真机测试；截图中的赛事标识、人物、旗帜、数据和素材不得用于本项目页面。

## `user-provided-concepts/`

- `concept-01-guangdong-composite.png`
- `concept-02-scnu-composite.png`

两张图片来自用户附件，只是校园羽毛球赛事效果概念，不是指定亚运会网站截图，也不是本项目现有功能证据。后续只提炼信息层级、间距、桌面表格与移动卡片的构图逻辑，不复制其中校名、标识、校徽、人物、队名、口号或比赛数据。

## `project-current/`

- `public-1440x900.png`
- `public-390x844.png`

来源：本机 `http://127.0.0.1:3127/public`，HTTP 200。截图证明当前公开端仍是固定读取 `phase-1-demo` 的阶段 1 匿名模拟骨架，没有赛事参数、筛选和详情路由。截取时仓库存在另一个会话的未提交裁判工作台改动，因此这些图片不是干净发布基线，也不代表裁判端验收结果。

## `generated-design-references/`

- `schedule-desktop.png`、`schedule-mobile.png`：在读取现有项目和用户概念图后生成的原创布局探索。
- `match-detail-desktop.png`：公开比赛详情的原创信息层级探索。
- `officiating-tablet.png`：裁判工作台的原创平板构图探索。

这些图片只用于确定信息密度、阅读顺序和共享视觉语言，不是可交互产品，也没有直接作为页面背景或功能素材。生成图中可能出现的文字、学校名称和图形均不进入 fixture、正式页面或业务数据。

## `project-preview/`

来源：本机 UI-01-B 隔离预览，`ENABLE_PUBLIC_UI_PREVIEW=true`，Playwright Chromium。截图时间为 2026-09-20，本轮用例 14/14 通过后固化。

- 每日赛程：375×812、390×844、768×1024、1024×768、1440×900。
- 比赛详情：390×844、768×1024、1440×900。
- 赛程桌面端使用表格，899 像素及以下使用卡片；详情按数据动态显示五局。
- 浏览器断言 `document.documentElement.scrollWidth <= clientWidth`，只证明这些 Chromium 模拟视口无根级横向溢出。
- 全部内容是独立虚构 fixture；页面显著标记“模拟数据 · 界面预览”，不读取认证、数据库、正式公开接口或裁判 API。
- 这些截图不是 iPhone、Android、实体平板、读屏软件或生产部署验收。

文件 SHA-256 记录在同目录 `SHA256SUMS`。

## `daily-schedule-visual-fix/`

来源：本机 UI-01-B 隔离预览，`ENABLE_PUBLIC_UI_PREVIEW=true`，Playwright Chromium。用户在 2026-09-20 明确暂停全站美化，本目录只记录“每日赛程”的视觉修正。

- 主参考图与 `user-provided-concepts/concept-01-guangdong-composite.png` 的 SHA-256 一致；本轮只采用其图 1 桌面每日赛程和图 2 手机每日赛程，排除图 3 比赛详情。
- `before/`：修改前 1440×1000、390×844、820×1180 三个 CSS 视口的真实页面截图。
- `round-1/`、`round-2/`、`round-3/`：三轮以内的实际读图与调整证据；长姓名场景使用 2026-10-15 稳定虚构 fixture。
- `after/`：最终交付截图，含 1440×1000 桌面、390×844 手机、820×1180 平板和 390×844 长双打姓名场景；文件名均标明日期、CSS 视口和 Chromium。
- 这些图只证明本机 Chromium 模拟视口与隔离模拟数据的布局结果，不是真机、真实公开接口、生产部署或用户视觉确认。

### `feedback-round/`

用户在实际读图和重新运行页面后指出状态区、对阵对齐、比分层级、手机卡片垂直预算与标题比例仍有偏差；该目录记录这次明确反馈后的定向收口，不算前述三轮自主视觉迭代的追加盲调。

- `before/`：收到反馈时的当前页面，重新等待“共 8 场比赛”解析完成后保存 1440×1000、820×1180、390×844 三个 CSS 视口；初次误抓到的加载骨架已被正确实页覆盖，不作为证据。
- `after/`：修正后同三视口及 390×844 的 2026-10-15 长姓名/五局场景。
- 桌面 8 行实测均为 76px；标题 48.96px；手机普通卡 173px、两条对阵行各 48px；三个主视口根级横向溢出均为 0。
- 手机仍分别显示比赛进度和结果确认；异常结果进入比赛元数据，桌面状态列固定为两项，未删除业务语义。
- 图片是 Chromium 模拟 CSS 视口的全页截图，画布高度随页面内容增长，不代表截图设备物理分辨率。
