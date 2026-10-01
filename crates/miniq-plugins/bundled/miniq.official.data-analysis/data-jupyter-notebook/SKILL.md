---
name: data-jupyter-notebook
displayName: Jupyter Notebook 数据分析
description: 当用户要新建、整理、修复或执行 Jupyter Notebook（ipynb）时使用，例如把分析脚本改写成可复现的 notebook、清理杂乱的 notebook、从头运行并检查报错、导出 HTML 或脚本、提交前清空输出
version: 1
---

# Jupyter Notebook

## 触发场景
- “帮我建个 notebook 做分析”“这个 ipynb 太乱了整理一下”
- “把 notebook 跑一遍看有没有报错”“转成 HTML/脚本”“提交前清一下输出”
- 需要把分析过程整理成可复现、可交接的 notebook

## 前置条件
- `python3`；执行与导出需要 `jupyter`、`nbformat`、`nbconvert`、`ipykernel`
- 检查：`shell_run` `python3 <技能目录>/scripts/nb_tool.py validate <文件>`（仅需标准库）；执行前 `python3 -m jupyter --version`
- 缺依赖时向用户说明，确认后 `python3 -m pip install --user jupyter nbformat nbconvert ipykernel`（有项目虚拟环境时优先装在其中）
- 结构规范见 `references/notebook-structure.md`；安全注意见 `references/safety.md`；脚本参数见 `references/scripts-usage.md`

## 分步流程
1. **审阅**：已有 notebook 用 `file_read` 读取（JSON），梳理单元格顺序、依赖的数据文件与库、隐藏状态（执行编号乱序、变量先用后定义）、`!`/`%` 命令。来源不明的先按 `references/safety.md` 审查。
2. **新建**：不要手写整份 JSON。`shell_run` `python3 <技能目录>/scripts/nb_tool.py scaffold <名称>.ipynb --title "<标题>"` 生成标准骨架（标题与目标 → 环境与导入 → 参数 → 数据加载 → 清洗 → 分析 → 结论），再填充内容；也可 `file_write` 写一个用 `nbformat.v4.new_notebook/new_markdown_cell/new_code_cell` 构造的脚本后运行。已有 `.py` 分析脚本可按 `# %%` 分段转成单元格。
3. **整理**：编辑前先备份为 `<名称>.bak.ipynb`。合并碎片单元格、删除调试输出、把硬编码路径与常量集中到参数单元格、补充 Markdown 小标题与解读。小改动用 `file_edit` 改 `source`；大改动用 nbformat 脚本重建。
4. **校验结构**：`nb_tool.py validate <文件>`，检查 JSON 结构、执行顺序、错误输出、超大输出、疑似密钥。
5. **执行**：`nb_tool.py run <文件> [--timeout 600] [-o 输出]`（有 jupyter 时调用 `nbconvert --execute`，默认写入 `<名>.executed.ipynb`；无 jupyter 时降级为纯 Python 执行、结果不写回，退出码 2）；或直接 `python3 -m jupyter nbconvert --to notebook --execute <名称>.ipynb --output <名称>.ipynb --ExecutePreprocessor.timeout=600`。失败时从错误输出定位单元格，修复后重跑，直到自上而下完整通过。
6. **检查输出**：`file_grep` 在 `.ipynb` 中搜索 `"output_type": "error"`；图表可导出后用 `view_image` 抽查；关键数字与分析结论核对。
7. **导出/清理**（按需）：
   - HTML：`python3 -m jupyter nbconvert --to html <名称>.ipynb`
   - 脚本：`nb_tool.py to-py <文件>`（无 nbconvert 也可用）
   - 清空输出（提交 git 前）：`nb_tool.py strip <文件>` 或 `python3 -m jupyter nbconvert --clear-output --inplace <名称>.ipynb`
8. **汇报**：文件路径、结构概览、执行结果（通过/失败单元格）、导出文件。

## 工具与参数要点

- `shell_run` 脚手架：`python3 <本技能目录>/scripts/nb_tool.py scaffold <文件.ipynb> --template analysis|tutorial|diagnostic --title 标题 [--force]`
- 校验：`nb_tool.py validate <文件> [--json]`，只需标准库，发现错误时退出码为 3。执行：`nb_tool.py run <文件> [-o 输出.ipynb] [--timeout 600] [--kernel python3] [--fallback]`
- 找不到 jupyter nbconvert 时会自动降级（`--fallback` 可强制降级）：抽出代码单元用 python3 按顺序执行，但不写回输出，退出码 2，并提示 `python3 -m pip install --user nbconvert nbclient ipykernel`
- 分享前：`nb_tool.py strip <文件> -o <输出> [--keep-count]` 清除输出；`nb_tool.py to-py <文件> -o x.py` 导出脚本便于审阅
- 编辑单元格时，优先用 `file_read` 读取后再用 `file_write`/`file_edit` 修改 JSON；修改后务必再跑一次 validate
- `view_image`：检查 Notebook 中导出的图

## 质量检查
- 能在新内核中自上而下无错误执行（“重启并全部运行”等价）
- 参数集中在一处；数据路径相对项目根或由参数给出
- 每节有 Markdown 标题与解读，结尾有结论单元格
- 无密钥、无个人数据输出；输出体积合理（大表只显示 head）
- 随机过程固定种子；依赖版本记录在环境单元格

## 失败回退
- 无 jupyter：用 `nb_tool.py` 完成 scaffold/validate/strip/to-py；`nb_tool.py run --fallback` 或 `to-py` 后用 `python3` 运行脚本验证逻辑，并说明未在 Jupyter 内核中执行
- 内核名不匹配：`python3 -m ipykernel install --user`，或在元数据中改为 `python3`
- 执行超时：加大超时，或把耗时步骤缓存到文件
- 数据文件缺失：在参数单元格标注所需文件，向用户索取

## 交付格式
- `<名称>.ipynb`（已执行或已清空输出，按用户要求），备份 `<名称>.bak.ipynb`
- 可选：`<名称>.html`、`<名称>.py`
- 对话中：结构概览、执行结果、注意事项
