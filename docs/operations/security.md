# 安全边界

**范围**：本服务默认威胁模型（本地单用户、不可信模型输出）。

<a id="host_header"></a>
## Host 头与绑定

默认 `127.0.0.1` + `hostCheck.isHostAllowed` 防 DNS rebinding。  
绑定非 loopback 时**跳过** Host 校验（显式承担风险）。

<a id="path_validation"></a>
## 路径校验

- Session path：必须在配置的 sessions 目录内，且 `.jsonl` 结尾；registry 键 realpath 归一。
- 静态文件：禁止目录穿越。

<a id="local_image"></a>
## local-image

`/api/local-image`：绝对路径、文件存在、**魔数**判定 PNG/JPEG/GIF/WEBP（不看扩展名）；单文件上限 64MB。不是任意文件读接口。

<a id="untrusted_render"></a>
## 不可信渲染

助手/用户 Markdown → DOMPurify。Mermaid SVG 不经 sanitize，依赖 mermaid `securityLevel: 'strict'`。工具输出纯文本。

<a id="settings_writes"></a>
## 设置写盘

仅接受白名单扁平补丁，见 [设置页与配置写盘](settings_and_config.md#settings_json_patch)。
