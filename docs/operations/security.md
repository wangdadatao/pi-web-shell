# 安全边界

**范围**：本服务的本地威胁模型：浏览器里的其它页面、不可信模型输出、以及非 loopback 绑定。  
**不覆盖**：pi 子进程本身的工具权限（那是 pi 的事）；设置字段白名单的逐项说明见 [设置页与配置写盘](settings_and_config.md)。

## 导航

- [Host 头](#host_header)
- [安装级凭证](#auth_token)
- [来源校验](#origin_check)
- [写请求的 Content-Type](#write_content_type)
- [路径校验](#path_validation)
- [local-image](#local_image)
- [不可信渲染](#untrusted_render)
- [响应头](#response_headers)
- [设置写盘](#settings_writes)

<a id="host_header"></a>
## Host 头与绑定

默认绑定 `127.0.0.1`。此时 `hostCheck.isHostAllowed` 只接受 loopback 的 Host，用来挡 DNS rebinding。  
绑定非 loopback 时跳过 Host 校验（调用方显式改了监听地址）。**凭证和来源校验不会因此跳过。**

<a id="auth_token"></a>
## 安装级凭证

每个 agent 目录一份随机凭证，文件 `<agentDir>/web-shell-token`，权限 `0600`，重启后复用。内容不是合法凭证时重新生成。

- 所有 `/api` 请求必须带上它。`fetch` 用请求头 `X-Pi-Shell-Token`。
- `EventSource`（`/api/stream`、`/api/events`）和 `<img>`（`/api/local-image`、`/api/image/<hash>`）不能设请求头，这些 GET 也接受查询参数 `token`。写请求不接受查询参数。
- 启动时把带片段的地址打到终端并用来打开浏览器：`http://<host>:<port>/#token=...`。片段不会随页面请求发出。前端写入 `localStorage` 后从地址栏去掉片段，同一浏览器之后打开不带片段的地址即可。
- 凭证无效时页面展示说明，让用户重新打开终端里打印的地址，而不是只看到一个空的 401。
- 除这行启动输出外，不要记录含凭证的完整 URL。

<a id="origin_check"></a>
## 来源校验

每条 `/api` 请求都检查 `Origin` 和 `Sec-Fetch-Site`，与是否 loopback 无关。

- `Sec-Fetch-Site` 只允许 `same-origin` 和 `none`（以及浏览器没带这个头的非浏览器客户端）。`cross-site` 和 `same-site` 拒绝。
- 带了 `Origin` 时，必须等于 `http://` 加上本次请求的 Host。`null` 和不匹配的来源拒绝。
- 静态页面本身不要求凭证，否则浏览器拿不到前端脚本。

<a id="write_content_type"></a>
## 写请求的 Content-Type

`POST` / `PUT` / `PATCH` / `DELETE` 的 `/api` 只接受 `application/json`（可带 charset 等参数）。其它类型，包括缺失的 `Content-Type`，返回 **415**，且不把正文当 JSON 解析。

<a id="path_validation"></a>
## 路径校验

- Session path：必须在配置的 sessions 目录内，且 `.jsonl` 结尾；registry 键 realpath 归一。
- 静态文件：禁止目录穿越。

<a id="local_image"></a>
## local-image

`GET /api/local-image?path=&session=`：`session` 是已打开或已索引的会话，图片的 realpath 必须落在该会话的 cwd 里面（符号链接先解析）。类型只看**魔数**（PNG/JPEG/GIF/WEBP，不看扩展名）；单文件上限 64MB。cwd 之外返回 403。

<a id="untrusted_render"></a>
## 不可信渲染

助手/用户 Markdown → DOMPurify。工具输出纯文本。

页面的 `Content-Security-Policy` 不允许内联脚本（`script-src 'self'`，没有 `unsafe-inline` / `unsafe-eval`）。主题和 Prism 的启动脚本因此是独立文件。

Mermaid 仍按原路径渲染（`securityLevel: 'strict'`，源码放文本节点）。返回的 SVG 先按 SVG 配置过 DOMPurify：保留图表标签用的 `foreignObject` 和 `<style>`，去掉 `script`、`iframe`、`object`、`embed`。若清洗后仍有 `script`、事件属性或 `javascript:`，则整段不插入。样式指令仍允许 `'unsafe-inline'`，否则图表里的表现样式会被丢掉。Mermaid 是否继续保留的决定尚未做出。

<a id="response_headers"></a>
## 响应头

所有响应带 `Referrer-Policy: no-referrer`，以及上面的 CSP。这样文档和子资源请求都不会把带查询参数的地址带到别处。

<a id="settings_writes"></a>
## 设置写盘

仅接受白名单扁平补丁，见 [设置页与配置写盘](settings_and_config.md#settings_json_patch)。这些写端点同样要过凭证、来源和 `application/json` 检查。
