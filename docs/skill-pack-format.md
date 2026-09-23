# miniQ 技能能力包

插件目录可以把可复用工作流和工具插件一起分发。纯技能包的 `manifest.toml` 使用
`runtime = "skills"`，每个 `skills` 项是包含 `SKILL.md` 的相对目录：

```toml
id = "dev.example.documents"
name = "Document workflows"
version = "1.2.0"
api_version = "1.0.0"
runtime = "skills"
capabilities = ["skills"]
skills = ["document-workflow", "pdf-workflow"]
requires = ["pdftoppm"]
```

`SKILL.md` 的 frontmatter 必须有 `name`、`description` 和语义版本号对应的整数
`version`。可选的 `requires.bins` 会在技能列表里显示当前 PATH 中是否有依赖，缺失依赖
不会阻止安装，但 agent 会在执行前得到清晰提示。`allowed_tools` 应只列出 miniQ
实际提供的工具。

插件页的“更新”会校验整个目录后原子替换已安装版本；技能页的“导入技能包”也支持直接
导入一个 `SKILL.md` 目录或包含多个技能子目录的目录。复制过程拒绝符号链接，避免导入
包越出源目录。
