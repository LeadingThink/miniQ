import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  BarChart3,
  BriefcaseBusiness,
  Code2,
  Home,
  LayoutGrid,
  LucideProps,
  Palette,
  Search,
  Sparkles,
  Upload,
} from "lucide-react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import { isTauriRuntime } from "../runtime";
import { RemotePathDialog } from "./RemotePathDialog";
import { EmptyState } from "./ui/EmptyState";
import { Switch } from "./ui/Switch";
import { showUndoToast, useToast } from "./ui/Toast";
import { skillDisplayName } from "../skillDisplay";
import "./Skills.css";

interface SkillView {
  name: string;
  displayName?: string;
  description: string;
  version: number;
  origin: string;
  source: "project" | "user" | "bundled" | "plugin";
  enabled: boolean;
  dependencies?: { command: string; available: boolean }[];
}

interface SkillDetailView extends SkillView {
  body: string;
  files: string[];
  skillDir?: string;
}

const SOURCE_LABEL: Record<SkillView["source"], string> = {
  project: "项目",
  user: "我的",
  bundled: "内置",
  plugin: "插件",
};
const CATEGORY_LABEL = [
  "全部",
  "办公协同",
  "开发工具",
  "内容创作",
  "数据分析",
  "生活服务",
] as const;
type Category = (typeof CATEGORY_LABEL)[number];
type CategoryIcon = ComponentType<LucideProps>;
const CATEGORY_ICONS: Record<Category, CategoryIcon> = {
  全部: LayoutGrid,
  办公协同: BriefcaseBusiness,
  开发工具: Code2,
  内容创作: Palette,
  数据分析: BarChart3,
  生活服务: Home,
};

function categoryFor(skill: SkillView): Exclude<Category, "全部"> {
  const text =
    `${skill.name} ${skillDisplayName(skill)} ${skill.description}`.toLocaleLowerCase();
  if (/(code|dev|git|编程|代码|前端|后端|软件|terminal|开发)/i.test(text))
    return "开发工具";
  if (/(data|csv|excel|sql|分析|报表|数据|统计|chart)/i.test(text))
    return "数据分析";
  if (
    /(write|copy|content|文案|写作|翻译|设计|图片|内容|创作|markdown)/i.test(
      text,
    )
  )
    return "内容创作";
  if (/(life|travel|health|生活|旅行|健康|日程|天气)/i.test(text))
    return "生活服务";
  return "办公协同";
}

function SkillDetail(props: {
  detail: SkillDetailView;
  onBack: () => void;
  onRemove: (skill: SkillView) => void;
}) {
  const { detail } = props;
  return (
    <div className="skill-detail">
      <div className="card-head">
        <button className="ghost" onClick={props.onBack}>
          ← 返回
        </button>
        <span className="tool-name">{skillDisplayName(detail)}</span>
        <span className="badge">{SOURCE_LABEL[detail.source]}</span>
        <span className="badge">v{detail.version}</span>
      </div>
      {skillDisplayName(detail) !== detail.name && (
        <div className="settings-status">技能标识：{detail.name}</div>
      )}
      <div className="skill-detail-description">{detail.description}</div>
      {detail.files.length > 0 && (
        <div className="settings-status">
          附带文件: {detail.files.join(", ")}
        </div>
      )}
      <pre className="skill-body">{detail.body}</pre>
      {detail.source === "user" && (
        <button className="danger" onClick={() => props.onRemove(detail)}>
          删除技能
        </button>
      )}
    </div>
  );
}

function SkillCard(props: {
  skill: SkillView;
  onOpen: (skill: SkillView) => void;
  onToggle: (skill: SkillView) => void;
}) {
  const { skill } = props;
  const Icon = CATEGORY_ICONS[categoryFor(skill)];
  return (
    <article className={`skill-card ${skill.enabled ? "" : "is-disabled"}`}>
      <div className="skill-card-top">
        <div className="skill-icon" aria-hidden="true">
          <Icon size={18} />
        </div>
        <span className="skill-category">{categoryFor(skill)}</span>
        <Switch
          checked={skill.enabled}
          label={`${skill.enabled ? "停用" : "启用"}${skillDisplayName(skill)}`}
          title={skill.enabled ? "点击禁用" : "点击启用"}
          onChange={() => props.onToggle(skill)}
        />
      </div>
      <button
        className="skill-card-title"
        onClick={() => props.onOpen(skill)}
        title={`查看 ${skillDisplayName(skill)}（${skill.name}）`}
      >
        {skillDisplayName(skill)}
      </button>
      <p className="skill-card-description">
        {skill.description || "暂无描述"}
      </p>
      <div className="skill-card-meta">
        <span className="badge">{SOURCE_LABEL[skill.source]}</span>
        <span className="badge">v{skill.version}</span>
        {(skill.dependencies ?? []).map((dependency) => (
          <span
            className="badge"
            key={dependency.command}
            title="运行时会检查该依赖是否在 PATH 中"
          >
            依赖 {dependency.command} {dependency.available ? "✓" : "缺少"}
          </span>
        ))}
      </div>
    </article>
  );
}

function EmptySkills() {
  return (
    <EmptyState
      icon={<Sparkles size={28} />}
      title="还没有技能"
      description="完成一次任务后，点右上角“保存为技能”，agent 就会学会这个工作流"
    />
  );
}

export function SkillsPanel(props: {
  client: RpcClient;
  workspaceId: string | null;
}) {
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const [detail, setDetail] = useState<SkillDetailView | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [remotePicker, setRemotePicker] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("all");
  const [availability, setAvailability] = useState("all");
  const [category, setCategory] = useState<Category>("全部");
  const [view, setView] = useState<"discover" | "enabled" | "mine">("discover");
  const toast = useToast();
  const scope = props.workspaceId ? { workspaceId: props.workspaceId } : {};
  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await props.client.call<{ skills: SkillView[] }>(
        "skill.list",
        scope,
      );
      if (generation === requestGeneration.current) setSkills(res.skills);
    } catch (error) {
      if (generation === requestGeneration.current)
        setLoadError(errorMessage(error));
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [props.client, props.workspaceId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const toggle = async (skill: SkillView) => {
    try {
      await props.client.call("skill.setEnabled", {
        name: skill.name,
        enabled: !skill.enabled,
      });
      await refresh();
    } catch (error) {
      setStatus(errorMessage(error));
    }
  };
  const open = async (skill: SkillView) => {
    try {
      setDetail(
        await props.client.call<SkillDetailView>("skill.read", {
          name: skill.name,
          ...scope,
        }),
      );
    } catch (error) {
      setStatus(errorMessage(error));
    }
  };
  const unhide = (name: string) =>
    setHidden((current) => {
      const next = new Set(current);
      next.delete(name);
      return next;
    });
  const remove = async (skill: SkillView) => {
    const deleteScope = scope;
    setHidden((current) => new Set(current).add(skill.name));
    setDetail(null);
    showUndoToast(toast, {
      message: `已删除技能“${skillDisplayName(skill)}”`,
      onUndo: () => unhide(skill.name),
      onCommit: () => {
        void (async () => {
          try {
            await props.client.call("skill.delete", {
              name: skill.name,
              ...deleteScope,
            });
            await refresh();
          } catch (error) {
            setStatus(errorMessage(error));
          } finally {
            unhide(skill.name);
          }
        })();
      },
    });
  };
  const importPackage = async () => {
    if (props.client.sshHost) {
      setRemotePicker(true);
      return;
    }
    let path: string | null = null;
    try {
      if (isTauriRuntime()) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          directory: true,
          multiple: false,
          title: "选择技能包目录",
        });
        path = typeof selected === "string" ? selected : null;
      } else path = window.prompt("技能包目录（绝对路径）:");
    } catch (error) {
      setStatus(errorMessage(error));
      return;
    }
    if (!path) return;
    try {
      const result = await props.client.call<{
        skills: SkillView[];
        imported: SkillView[];
      }>("skill.import", { path });
      setSkills(result.skills);
      setStatus(`已导入 ${result.imported.length} 个技能，可在列表中查看版本`);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  };
  const visibleSkills = skills.filter((skill) => !hidden.has(skill.name));
  const query = search.trim().toLocaleLowerCase();
  const filteredSkills = visibleSkills.filter(
    (skill) =>
      (!query ||
        `${skillDisplayName(skill)} ${skill.name} ${skill.description}`
          .toLocaleLowerCase()
          .includes(query)) &&
      (category === "全部" || categoryFor(skill) === category) &&
      (view === "discover" ||
        (view === "enabled" ? skill.enabled : skill.source === "user")) &&
      (source === "all" || skill.source === source) &&
      (availability === "all" ||
        (availability === "enabled"
          ? skill.enabled
          : (skill.dependencies ?? []).some(
              (dependency) => !dependency.available,
            ))),
  );
  const curatedSkills = filteredSkills.slice(0, 4);
  const listingSkills =
    view === "discover" && !query && category === "全部"
      ? filteredSkills.slice(curatedSkills.length)
      : filteredSkills;
  const resetFilters = () => {
    setSearch("");
    setSource("all");
    setAvailability("all");
    setCategory("全部");
    setView("discover");
  };

  return (
    <div className="page">
      {remotePicker && props.client.sshHost && (
        <RemotePathDialog
          host={props.client.sshHost}
          purpose="skill"
          onClose={() => setRemotePicker(false)}
          onSubmit={async (path) => {
            const result = await props.client.call<{
              skills: SkillView[];
              imported: SkillView[];
            }>("skill.import", { path });
            setSkills(result.skills);
            setStatus(`已导入 ${result.imported.length} 个远程技能`);
          }}
        />
      )}
      <div className="page-inner wide">
        <div className="page-header skills-page-header">
          <div>
            <div className="page-title">技能</div>
            <div className="page-sub">
              发现和管理可复用的工作流。启用后模型可按任务选择技能，并非每次都会执行。
            </div>
          </div>
          <button
            onClick={() => void importPackage()}
            title="导入或更新包含一个或多个 SKILL.md 的目录"
          >
            <Upload size={15} />
            导入技能包
          </button>
        </div>
        {status && <div className="settings-status">{status}</div>}
        {loading && (
          <div className="settings-status" role="status">
            正在加载技能…
          </div>
        )}
        {loadError && (
          <div className="settings-status" role="alert">
            {loadError}
            <button className="ghost" onClick={() => void refresh()}>
              重试
            </button>
          </div>
        )}
        {!detail && visibleSkills.length > 0 && (
          <>
            <div
              className="skills-view-tabs"
              role="tablist"
              aria-label="技能视图"
            >
              <button
                className={view === "discover" ? "active" : ""}
                role="tab"
                aria-selected={view === "discover"}
                onClick={() => setView("discover")}
              >
                发现技能
              </button>
              <button
                className={view === "enabled" ? "active" : ""}
                role="tab"
                aria-selected={view === "enabled"}
                onClick={() => setView("enabled")}
              >
                已启用
              </button>
              <button
                className={view === "mine" ? "active" : ""}
                role="tab"
                aria-selected={view === "mine"}
                onClick={() => setView("mine")}
              >
                我的技能
              </button>
            </div>
            <div className="skill-category-row" aria-label="技能分类">
              {CATEGORY_LABEL.map((item) => {
                const Icon = CATEGORY_ICONS[item];
                return (
                  <button
                    key={item}
                    className={category === item ? "active" : ""}
                    aria-pressed={category === item}
                    onClick={() => setCategory(item)}
                  >
                    <Icon size={15} />
                    {item}
                  </button>
                );
              })}
            </div>
            <div className="skill-filters">
              <label className="skill-search">
                <Search size={16} />
                <input
                  aria-label="搜索技能"
                  placeholder="搜索任务、技能名称或描述"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <select
                aria-label="技能来源"
                value={source}
                onChange={(event) => setSource(event.target.value)}
              >
                <option value="all">全部来源</option>
                {Object.entries(SOURCE_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                aria-label="技能运行条件"
                value={availability}
                onChange={(event) => setAvailability(event.target.value)}
              >
                <option value="all">全部技能</option>
                <option value="enabled">已启用</option>
                <option value="missing">缺少依赖</option>
              </select>
              <span role="status">
                {filteredSkills.length} / {visibleSkills.length} 个技能
              </span>
            </div>
          </>
        )}
        {detail ? (
          <SkillDetail
            detail={detail}
            onBack={() => setDetail(null)}
            onRemove={remove}
          />
        ) : loading && visibleSkills.length === 0 ? null : loadError &&
          visibleSkills.length === 0 ? null : visibleSkills.length === 0 ? (
          <EmptySkills />
        ) : filteredSkills.length === 0 ? (
          <div className="settings-status skill-empty-filter">
            没有匹配的技能。试试其他关键词或筛选条件。
            <button className="ghost" onClick={resetFilters}>
              清除筛选
            </button>
          </div>
        ) : (
          <>
            {curatedSkills.length > 0 &&
              view === "discover" &&
              !query &&
              category === "全部" && (
                <section className="curated-section">
                  <div className="section-heading">
                    <div>
                      <h2>推荐技能</h2>
                      <p>来自当前技能库的快捷入口</p>
                    </div>
                    <span>{curatedSkills.length} 个</span>
                  </div>
                  <div className="skill-grid curated-grid">
                    {curatedSkills.map((skill) => (
                      <SkillCard
                        key={`curated-${skill.name}`}
                        skill={skill}
                        onOpen={(item) => void open(item)}
                        onToggle={toggle}
                      />
                    ))}
                  </div>
                </section>
              )}
            <section className="all-skills-section">
              <div className="section-heading">
                <div>
                  <h2>
                    {view === "enabled"
                      ? "已启用技能"
                      : view === "mine"
                        ? "我的技能"
                        : "全部技能"}
                  </h2>
                  <p>{filteredSkills.length} 个技能可用</p>
                </div>
              </div>
              {listingSkills.length > 0 ? (
                <div className="skill-grid">
                  {listingSkills.map((skill) => (
                    <SkillCard
                      key={skill.name}
                      skill={skill}
                      onOpen={(item) => void open(item)}
                      onToggle={toggle}
                    />
                  ))}
                </div>
              ) : (
                <div className="settings-status">推荐技能已显示在上方。</div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
