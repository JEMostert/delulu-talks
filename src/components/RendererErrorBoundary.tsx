import { Component, type ErrorInfo, type ReactNode } from "react";
import { bridge } from "../bridge";
import { RecoveryDrafts, recoveryError } from "../rendererRecovery";
import { RendererRecovery } from "./RendererRecovery";

type Props = {
  children: ReactNode;
  controllerFailed?: boolean;
  drafts?: RecoveryDrafts;
  localSavePending?: boolean;
};
type State = { error: string | null; componentStack: string };

export class RendererErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: "" };

  static getDerivedStateFromError(reason: unknown): Partial<State> {
    return { error: recoveryError(reason) };
  }

  componentDidCatch(_reason: unknown, info: ErrorInfo) {
    this.setState({
      componentStack: (info.componentStack ?? "").slice(0, 4_000),
    });
    if (this.props.controllerFailed) {
      // No error text or transcript content is sent to the main process.
      void bridge.rendererControllerFailed().catch(() => undefined);
    }
  }

  render() {
    if (this.state.error !== null) {
      return (
        <RendererRecovery
          error={this.state.error}
          componentStack={this.state.componentStack}
          controllerFailed={this.props.controllerFailed ?? false}
          drafts={this.props.drafts?.snapshot() ?? []}
          localSavePending={this.props.localSavePending ?? false}
        />
      );
    }
    return this.props.children;
  }
}
