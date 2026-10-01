---
name: playwright-e2e
description: 当用户要为 Web 项目编写、运行或修复 Playwright 端到端测试（含安装配置、调试失败用例）时使用
origin: installed
requires:
  bins:
    - npx
---

## 适用场景

用户说"给登录流程加 e2e 测试"、"跑一下 Playwright"、"这个 e2e 用例老是挂"。适用于 Node 生态的前端/全栈项目。

## 步骤（写明每步用哪个工具）

1. 了解项目：用 `file_read` 读取 `package.json`，用 `file_glob` 查找 `playwright.config.*`、`tests/`、`e2e/` 目录，判断是否已接入 Playwright。
2. 未接入时，先向用户说明将新增的依赖与文件，确认后用 `shell_run` 执行：
   - `npm install -D @playwright/test`
   - `npx playwright install chromium`（只装需要的浏览器，节省空间）
   - 用 `file_write` 创建 `playwright.config.ts`，配置 `testDir`、`baseURL`，以及 `webServer`（`command: 'npm run dev'`，`url` 指向本地端口，`reuseExistingServer: true`）。
3. 设计用例：与用户确认要覆盖的关键流程（如首页加载、登录、下单），每个流程一个 `test()`，放在 `e2e/<流程>.spec.ts`。
4. 编写规范：
   - 优先使用语义定位：`page.getByRole`、`getByLabel`、`getByText`，少用脆弱的 CSS 选择器。
   - 使用 web-first 断言：`await expect(locator).toBeVisible()`，不要写固定 `waitForTimeout`。
   - 测试数据独立，不依赖其他用例的执行顺序。
   - 需要登录时用 `storageState` 复用登录态，账号从环境变量读取，不硬编码。
5. 运行：`npx playwright test`；单个文件 `npx playwright test e2e/login.spec.ts`；指定浏览器 `--project=chromium`。
6. 调试失败：`npx playwright test --reporter=list` 看错误；`npx playwright test --trace on` 生成 trace，`npx playwright show-report` 查看报告（本地打开）。失败截图在 `test-results/` 下，用 `view_image` 查看。
7. 修复后重跑直至通过，并连续跑 2–3 次（`--repeat-each=3`）排查不稳定用例。
8. 可选：在 `package.json` 增加脚本 `"test:e2e": "playwright test"`，并建议把 `test-results/`、`playwright-report/` 加入 `.gitignore`。

## 注意事项 / 安全

- 安装依赖、修改配置文件前先告知用户。
- 不要针对生产环境运行会写入数据的用例；`baseURL` 默认指向本地或测试环境。
- 不要在测试代码中写入真实密码或令牌，改用环境变量。
- 不要用加大超时或 `test.skip` 掩盖真实缺陷，除非用户同意。

## 如何确认完成

新增/修改的用例在本地全部通过且重复运行稳定，向用户汇报用例列表、运行命令与结果。
