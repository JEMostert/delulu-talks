import { RewriteSetup } from "../../components/models/RewriteSetup";
import type { MagicStatus } from "../../types";
import type { SectionProps } from "./shared";

export function RewritingSection({
  magicStatus,
  onSetupMagic,
  onCancelSetupMagic,
  ...section
}: SectionProps & {
  magicStatus: MagicStatus;
  onSetupMagic: () => void;
  onCancelSetupMagic?: () => void;
}) {
  return (
    <RewriteSetup
      magicStatus={magicStatus}
      settings={section.settings}
      busy={section.busy}
      saving={section.saving}
      onUpdateSettings={section.save}
      onSetupMagic={onSetupMagic}
      onCancelSetupMagic={onCancelSetupMagic}
    />
  );
}
