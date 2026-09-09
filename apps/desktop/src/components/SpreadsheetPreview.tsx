import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Download,
  FileJson,
  FileWarning,
  ListFilter,
  Search,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  moveTabIndex,
  spreadsheetColumnLabel,
  spreadsheetRow,
} from "../documentPreviewModel";
import { decodeBase64 } from "../previewBinary";
import {
  cellText,
  spreadsheetView,
  type SheetCell,
  type SheetSort,
  type SheetFilters,
} from "../spreadsheetView";
import { spreadsheetCsv, spreadsheetJson } from "../spreadsheetExport";
import { downloadBlob } from "../downloadBlob";
import { exportFilename } from "../sessionExport";
import { CopyButton } from "./CopyButton";
import { usePreviewScroll, usePreviewValue } from "../previewViewState";
import "./PreviewInspectors.css";

export type PreviewSheet = { sheet: string; data: SheetCell[][] };
const ROWS_PER_PAGE = 200;

export function SpreadsheetPreview(props: {
  dataBase64: string;
  onError: (message: string) => void;
}) {
  const [sheets, setSheets] = useState<PreviewSheet[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSheets([]);
    void import("read-excel-file/browser")
      .then(({ default: readXlsxFile }) =>
        readXlsxFile(new Blob([decodeBase64(props.dataBase64)])),
      )
      .then((result) => {
        if (!cancelled) {
          setSheets(result as PreviewSheet[]);
          setLoading(false);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setLoading(false);
          props.onError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.dataBase64, props.onError]);
  return loading ? (
    <div className="diff-empty">正在解析工作簿...</div>
  ) : (
    <SpreadsheetDataView sheets={sheets} onError={props.onError} />
  );
}

export function SpreadsheetDataView(props: {
  sheets: PreviewSheet[];
  onError: (message: string) => void;
}) {
  const sheets = props.sheets;
  const [sheetName, setSheetName] = usePreviewValue<string | null>(
    "sheetName",
    null,
  );
  const sheetIndex = Math.max(
    0,
    sheets.findIndex((sheet) => sheet.sheet === sheetName),
  );
  const [page, setPage] = usePreviewValue("sheetPage", 0);
  const [query, setQuery] = usePreviewValue("sheetQuery", "");
  const [sort, setSort] = usePreviewValue<SheetSort>("sheetSort", null);
  const [filters, setFilters] = usePreviewValue<SheetFilters>(
    "sheetFilters",
    {},
  );
  const [filtersOpen, setFiltersOpen] = usePreviewValue(
    "sheetFiltersOpen",
    false,
  );
  const [selected, setSelected] = usePreviewValue<{
    row: number;
    column: number;
  } | null>("sheetSelection", null);
  const scroll = usePreviewScroll<HTMLDivElement>(`sheet:${sheetName}:${page}`);
  const focusRequested = useRef(false);
  const tableId = useId();
  const sheet = sheets[sheetIndex];
  const visible = useMemo(
    () => spreadsheetView(sheet?.data ?? [], query, sort, filters),
    [sheet, query, sort, filters],
  );
  const columnCount = useMemo(
    () =>
      sheet?.data.reduce((maximum, row) => Math.max(maximum, row.length), 0) ??
      0,
    [sheet],
  );
  const pageCount = Math.max(1, Math.ceil(visible.length / ROWS_PER_PAGE));
  const currentPage = Math.min(page, pageCount - 1);
  const rows = visible.slice(
    currentPage * ROWS_PER_PAGE,
    (currentPage + 1) * ROWS_PER_PAGE,
  );
  const selectionVisible =
    selected && rows.some((row) => row.number === selected.row);
  const selectSheet = (index: number) => {
    setSheetName(sheets[index].sheet);
    setPage(0);
    setSort(null);
    setQuery("");
    setFilters({});
    setSelected(null);
  };
  useEffect(() => {
    if (!focusRequested.current || !selected) return;
    document
      .getElementById(`${tableId}-${selected.row}-${selected.column}`)
      ?.focus();
    focusRequested.current = false;
  }, [selected, tableId]);

  const exportData = (format: "csv" | "json") => {
    try {
      downloadBlob(
        format === "csv"
          ? spreadsheetCsv(visible, columnCount)
          : spreadsheetJson(sheets),
        `${exportFilename(sheet?.sheet ?? "workbook")}.${format}`,
      );
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    }
  };

  if (!sheet)
    return (
      <div className="unsupported-preview">
        <FileWarning size={28} />
        <strong>工作簿中没有可显示的工作表</strong>
      </div>
    );

  return (
    <div className="spreadsheet-preview">
      <div className="sheet-tabs" role="tablist" aria-label="工作表">
        {sheets.map((item, index) => (
          <button
            key={`${item.sheet}-${index}`}
            id={`${tableId}-tab-${index}`}
            type="button"
            role="tab"
            aria-selected={index === sheetIndex}
            aria-controls={tableId}
            tabIndex={index === sheetIndex ? 0 : -1}
            className={index === sheetIndex ? "selected" : ""}
            onClick={() => selectSheet(index)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                return;
              event.preventDefault();
              const next = moveTabIndex(
                sheetIndex,
                sheets.length,
                event.key === "ArrowLeft" ? -1 : 1,
              );
              selectSheet(next);
              document.getElementById(`${tableId}-tab-${next}`)?.focus();
            }}
          >
            {item.sheet}
          </button>
        ))}
      </div>
      <div className="sheet-controls">
        <label className="timeline-search">
          <Search size={14} />
          <input
            type="search"
            aria-label="搜索整个工作表"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
              setSelected(null);
            }}
          />
        </label>
        {query && (
          <button
            type="button"
            className="icon-button"
            title="清空表格搜索"
            aria-label="清空表格搜索"
            onClick={() => {
              setQuery("");
              setPage(0);
            }}
          >
            <X size={14} />
          </button>
        )}
        <span role="status">
          {visible.length} / {sheet.data.length} 行
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label="列筛选"
          title="列筛选"
          aria-pressed={filtersOpen}
          onClick={() => setFiltersOpen((value) => !value)}
        >
          <ListFilter size={15} />
        </button>
        {Object.values(filters).some((value) => value.trim()) && (
          <button
            type="button"
            className="icon-button"
            aria-label="清空列筛选"
            title="清空列筛选"
            onClick={() => {
              setFilters({});
              setPage(0);
              setSelected(null);
            }}
          >
            <X size={15} />
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label="导出筛选结果 CSV"
          title="导出全部匹配行 CSV（公式字符串按文本处理）"
          onClick={() => exportData("csv")}
        >
          <Download size={15} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="导出完整工作簿 JSON"
          title="导出完整工作簿 JSON（保留原始值和日期类型）"
          onClick={() => exportData("json")}
        >
          <FileJson size={15} />
        </button>
      </div>
      <div
        {...scroll}
        id={tableId}
        className="sheet-table-wrap"
        role="tabpanel"
        aria-labelledby={`${tableId}-tab-${sheetIndex}`}
      >
        <table>
          <thead>
            <tr>
              <th aria-label="行号" />
              {Array.from({ length: columnCount }, (_, index) => (
                <th
                  key={index}
                  aria-sort={sort?.column === index ? sort.direction : "none"}
                >
                  <button
                    type="button"
                    className="sheet-column-sort"
                    title={`排序 ${spreadsheetColumnLabel(index)} 列`}
                    aria-label={`排序 ${spreadsheetColumnLabel(index)} 列`}
                    onClick={() => {
                      setSort(
                        sort?.column !== index
                          ? { column: index, direction: "ascending" }
                          : sort.direction === "ascending"
                            ? { column: index, direction: "descending" }
                            : null,
                      );
                      setPage(0);
                    }}
                  >
                    {spreadsheetColumnLabel(index)}
                    {sort?.column === index &&
                      (sort.direction === "ascending" ? (
                        <ArrowUp size={12} />
                      ) : (
                        <ArrowDown size={12} />
                      ))}
                  </button>
                  {filtersOpen && (
                    <input
                      className="sheet-column-filter"
                      aria-label={`筛选 ${spreadsheetColumnLabel(index)} 列`}
                      value={filters[index] ?? ""}
                      onChange={(event) => {
                        setFilters((current) => ({
                          ...current,
                          [index]: event.target.value,
                        }));
                        setPage(0);
                        setSelected(null);
                      }}
                    />
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={columnCount + 1} className="diff-empty">
                  {sheet.data.length === 0 ? "当前工作表为空" : "没有匹配的行"}
                </td>
              </tr>
            )}
            {rows.map((row, rowIndex) => (
              <tr key={row.number}>
                <th scope="row">{row.number}</th>
                {spreadsheetRow(row.cells, columnCount).map(
                  (cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      id={`${tableId}-${row.number}-${cellIndex}`}
                      title={cellText(cell)}
                      tabIndex={
                        selectionVisible && selected
                          ? selected.row === row.number &&
                            selected.column === cellIndex
                            ? 0
                            : -1
                          : rowIndex === 0 && cellIndex === 0
                            ? 0
                            : -1
                      }
                      onClick={() =>
                        setSelected({ row: row.number, column: cellIndex })
                      }
                      onKeyDown={(event) => {
                        if (
                          ![
                            "ArrowLeft",
                            "ArrowRight",
                            "ArrowUp",
                            "ArrowDown",
                            "Enter",
                          ].includes(event.key)
                        )
                          return;
                        event.preventDefault();
                        const nextIndex = Math.min(
                          Math.max(
                            currentPage * ROWS_PER_PAGE +
                              rowIndex +
                              (event.key === "ArrowUp"
                                ? -1
                                : event.key === "ArrowDown"
                                  ? 1
                                  : 0),
                            0,
                          ),
                          visible.length - 1,
                        );
                        const column = Math.min(
                          Math.max(
                            cellIndex +
                              (event.key === "ArrowLeft"
                                ? -1
                                : event.key === "ArrowRight"
                                  ? 1
                                  : 0),
                            0,
                          ),
                          columnCount - 1,
                        );
                        focusRequested.current = true;
                        setPage(Math.floor(nextIndex / ROWS_PER_PAGE));
                        setSelected({
                          row: visible[nextIndex].number,
                          column,
                        });
                      }}
                    >
                      {cellText(cell)}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected && (
        <div className="sheet-controls">
          <strong>
            {spreadsheetColumnLabel(selected.column)}
            {selected.row}
          </strong>
          <CopyButton
            content={cellText(sheet.data[selected.row - 1]?.[selected.column])}
            label="复制单元格"
            onError={props.onError}
          />
        </div>
      )}
      {selected && (
        <pre className="sheet-cell-value" aria-label="单元格完整值">
          {cellText(sheet.data[selected.row - 1]?.[selected.column])}
        </pre>
      )}
      {pageCount > 1 && (
        <div className="sheet-pagination">
          <button
            type="button"
            className="icon-button"
            aria-label="上一页"
            title="上一页"
            disabled={page === 0}
            onClick={() => setPage((value) => Math.max(0, value - 1))}
          >
            <ChevronLeft size={16} />
          </button>
          <span>
            第 {currentPage + 1} / {pageCount} 页 · 共 {visible.length} 行
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="下一页"
            title="下一页"
            disabled={page + 1 >= pageCount}
            onClick={() =>
              setPage((value) => Math.min(pageCount - 1, value + 1))
            }
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
