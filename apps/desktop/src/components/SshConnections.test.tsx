// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SshConnections, type SshConnectionsProps } from "./SshConnections";
afterEach(cleanup);
const props = (): SshConnectionsProps => ({ activeHost: null, canManage: true, hosts: [{ hostId: "work", label: "Work", state: "connected" }], discovered: [{ alias: "other", hostName: "example.test" }], onSelectHost: vi.fn(), onSave: vi.fn().mockResolvedValue(undefined), onRemove: vi.fn().mockResolvedValue(undefined), onDisconnect: vi.fn().mockResolvedValue(undefined), onRefresh: vi.fn().mockResolvedValue(undefined) });

it("adds a validated target through the root without submitting the settings form", async () => {
  const input = props(), submit = vi.fn((event) => event.preventDefault());
  render(<form onSubmit={submit}><SshConnections {...input} /></form>);
  fireEvent.change(screen.getByLabelText("SSH 主机地址"), { target: { value: " dev@example.test " } });
  fireEvent.keyDown(screen.getByLabelText("SSH 主机地址"), { key: "Enter" });
  await waitFor(() => expect(input.onSave).toHaveBeenCalledWith("dev@example.test"));
  expect(submit).not.toHaveBeenCalled();
  expect(screen.queryByLabelText(/密码/)).toBeNull();
});

it("rejects commands and malformed targets while accepting IPv6", async () => {
  const input = props(); render(<SshConnections {...input} />);
  for (const target of ["ssh work", "-oProxyCommand=x", "ssh://host", "host:2222", "user@@host", "host;touch x", "[host]"]) {
    fireEvent.change(screen.getByLabelText("SSH 主机地址"), { target: { value: target } });
    fireEvent.click(screen.getByText("添加电脑"));
    await screen.findByRole("alert");
    expect(input.onSave).not.toHaveBeenCalled();
  }
  fireEvent.change(screen.getByLabelText("SSH 主机地址"), { target: { value: "dev@[::1]" } });
  fireEvent.click(screen.getByText("添加电脑"));
  await waitFor(() => expect(input.onSave).toHaveBeenCalledWith("dev@[::1]"));
});

it("mobile connects saved computers without exposing host or workspace authorization", () => {
  const input = props(); render(<SshConnections {...input} canManage={false} />);
  expect(screen.queryByLabelText("SSH 主机地址")).toBeNull();
  expect(screen.queryByTitle("移除 work")).toBeNull();
  expect(screen.queryByText("other")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Work work/ }));
  expect(input.onSelectHost).toHaveBeenCalledWith("work");
});

it("reports root refresh errors and routes disconnect/remove separately", async () => {
  const input = props(); input.onRefresh = vi.fn().mockRejectedValue(new Error("registry unavailable"));
  render(<SshConnections {...input} />);
  fireEvent.click(screen.getByTitle("刷新主机列表"));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "registry unavailable");
  fireEvent.click(screen.getByTitle("移除 work"));
  await waitFor(() => expect(input.onRemove).toHaveBeenCalledWith("work"));
  fireEvent.click(screen.getByText("断开"));
  await waitFor(() => expect(input.onDisconnect).toHaveBeenCalledWith("work"));
});
