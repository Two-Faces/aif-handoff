import { useState } from "react";
import { Markdown } from "@/components/ui/markdown";
import { EmptyState } from "@/components/ui/empty-state";
import { Collapsible } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AlertBox } from "@/components/ui/alert-box";
import type { SyncRevisions } from "@aif/shared/browser";

interface TaskPlanProps {
  plan: string | null;
  revisions?: SyncRevisions;
  onSave?: (plan: string, expected: SyncRevisions | undefined) => Promise<unknown>;
}

export function TaskPlan({ plan, revisions, onSave }: TaskPlanProps) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<{ text: string; expected: SyncRevisions | undefined } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (onSave)
    return (
      <div className="space-y-3">
        {draft ? (
          <>
            <Textarea
              aria-label="Board plan"
              rows={12}
              value={draft.text}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={saving}
                onClick={() => {
                  setSaving(true);
                  setError(null);
                  void onSave(draft.text, draft.expected)
                    .then(
                      () => setDraft(null),
                      (failure: unknown) =>
                        setError(
                          failure instanceof Error ? failure.message : "Plan could not be saved",
                        ),
                    )
                    .finally(() => setSaving(false));
                }}
              >
                {saving ? "Saving…" : "Save board plan"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => {
                  setDraft(null);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDraft({ text: plan ?? "", expected: revisions })}
            >
              Edit board plan
            </Button>
            {plan ? (
              <Markdown content={plan} className="text-sm text-foreground/90" />
            ) : (
              <EmptyState message="No board plan yet" />
            )}
          </>
        )}
        {error && (
          <AlertBox variant="error">
            {error} Your draft is preserved. Review the latest version before retrying.
          </AlertBox>
        )}
      </div>
    );

  if (!plan) {
    return <EmptyState message="No plan generated yet" />;
  }

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      trigger={expanded ? "Hide plan" : "Show plan"}
      className="space-y-3"
    >
      <Markdown content={plan} className="text-sm text-foreground/90" />
    </Collapsible>
  );
}
