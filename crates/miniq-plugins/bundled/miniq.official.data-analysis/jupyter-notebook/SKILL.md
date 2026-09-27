---
name: jupyter-notebook
description: 当用户要新建、整理、修复或执行 Jupyter Notebook（.ipynb），例如把分析脚本改写成 notebook、清理杂乱的 notebook、批量运行并保存输出时使用
origin: installed
requires:
  bins:
    - python3
---

## 适用场景

用户说"帮我建个 notebook 做分析"、"这个 ipynb 太乱了整理一下"、"把 notebook 跑一遍看有没有报错"、"转成 HTML/脚本"。

## 步骤（写明每步用哪个工具）

1. 检查环境：用 `shell_run` 执行 `python3 -m jupyter --version` 与 `python3 -c "import nbformat"`。缺少时向用户说明，确认后执行 `python3 -m pip install --user jupyter nbformat nbconvert`（有虚拟环境时优先装在项目环境中）。
2. 读取现有 notebook：用 `file_read` 读取 `.ipynb`（JSON），梳理单元格顺序、依赖的数据文件与库、是否存在隐藏状态（执行编号乱序、变量在后文定义前文使用）。
3. 新建 notebook：不要手写整份 JSON，改用 `file_write` 生成一个 Python 脚本，用 `nbformat` 构造：
   - `nb = nbformat.v4.new_notebook()`，依次添加 `new_markdown_cell` 与 `new_code_cell`，最后 `nbformat.write(nb, "<名称>.ipynb")`；用 `shell_run` 运行该脚本。
   - 推荐结构：标题与目标 → 环境与导入 → 参数（路径、常量集中一个单元格）→ 数据加载 → 清洗 → 分析（每节一个 Markdown 小标题）→ 结论。
4. 整理已有 notebook：合并碎片单元格、删除调试输出、把硬编码路径集中到参数单元格、补充 Markdown 说明；小改动可用 `file_edit` 直接改 JSON 中的 `source`，大改动用 `nbformat` 脚本重建。编辑前先备份为 `<名称>.bak.ipynb`。
5. 执行验证：`python3 -m jupyter nbconvert --to notebook --execute <名称>.ipynb --output <名称>.ipynb --ExecutePreprocessor.timeout=600`。失败时从错误输出定位单元格，修复后重跑，直到自上而下完整运行通过。
6. 检查输出：用 `file_grep` 在 `.ipynb` 中搜索 `"output_type": "error"`；图表输出可导出后用 `view_image` 抽查。
7. 按需导出：`python3 -m jupyter nbconvert --to html <名称>.ipynb` 或 `--to script`；提交到 git 前可建议清空输出：`python3 -m jupyter nbconvert --clear-output --inplace <名称>.ipynb`。
8. 向用户汇报文件路径、结构概览、执行结果。

## 注意事项 / 安全

- 执行 notebook 会运行其中全部代码；来源不明的 notebook 先用 `file_read` 审阅是否有删除文件、网络请求、`!` shell 命令等操作，再向用户确认后执行。
- 不在 notebook 中写入密钥，改用环境变量读取。
- 覆盖原 notebook 前先备份；安装依赖前先确认。
- 不要依赖交互式 Jupyter 界面，所有操作通过命令行完成。

## 如何确认完成

notebook 能从头到尾无错误执行，结构清晰（有标题、说明和结论），用户要求的导出文件已生成。
