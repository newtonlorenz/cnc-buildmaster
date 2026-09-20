import { useId, type ReactNode, type ComponentProps } from "react";
import { Square } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorkbench } from "@/workbench-context";
export function Field({
  label,
  help,
  children,
  className,
  htmlFor,
}: {
  label: string;
  help?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cn("field", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {help && <p className="field-help">{help}</p>}
    </div>
  );
}
export function NumberField({
  label,
  help,
  ...props
}: ComponentProps<typeof Input> & { label: string; help?: ReactNode }) {
  const generated = useId(),
    id = props.id || generated;
  return (
    <Field label={label} help={help} htmlFor={id}>
      <Input {...props} id={id} type="number" step={props.step ?? "any"} />
    </Field>
  );
}
export function SelectField({
  label,
  help,
  options,
  children,
  ...props
}: ComponentProps<typeof NativeSelect> & {
  label: string;
  help?: ReactNode;
  options?: { value: string; label: string }[];
}) {
  const generated = useId(),
    id = props.id || generated;
  return (
    <Field label={label} help={help} htmlFor={id}>
      <NativeSelect {...props} id={id}>
        {options?.map((o) => (
          <NativeSelectOption key={o.value} value={o.value}>
            {o.label}
          </NativeSelectOption>
        ))}
        {children}
      </NativeSelect>
    </Field>
  );
}
export function CheckField({
  label,
  help,
  checked,
  onCheckedChange,
  id: passedId,
  disabled,
  className,
  ...props
}: ComponentProps<typeof Checkbox> & { label: ReactNode; help?: ReactNode }) {
  const generated = useId(),
    id = passedId || generated;
  return (
    <div className={cn("check-field", className)}>
      <Checkbox
        {...props}
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      />
      <div>
        <Label htmlFor={id} className={disabled ? "text-muted-foreground" : ""}>
          {label}
        </Label>
        {help && <p className="field-help">{help}</p>}
      </div>
    </div>
  );
}
export function Panel({
  title,
  description,
  children,
  className,
  action,
  id,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
  id?: string;
}) {
  return (
    <Card id={id} className={cn("workbench-panel", className)}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{title}</CardTitle>
            {description && (
              <CardDescription className="mt-1.5">
                {description}
              </CardDescription>
            )}
          </div>
          {action}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
export function StopButton({
  className,
  id,
  ...props
}: ComponentProps<typeof Button>) {
  const { client } = useWorkbench();
  return (
    <Button
      {...props}
      id={id}
      variant="destructive"
      className={cn("stop-button", className)}
      onClick={() => void client.stop()}
    >
      <Square className="fill-current" />
      Stop<span className="stop-shortcut">Esc</span>
    </Button>
  );
}
export function Notice({
  children,
  tone = "default",
  className,
}: {
  children: ReactNode;
  tone?: "default" | "warning" | "error" | "success";
  className?: string;
}) {
  return (
    <Alert
      role={tone === "error" ? "alert" : "status"}
      variant={tone === "error" ? "destructive" : "default"}
      className={cn("notice", `notice-${tone}`, className)}
    >
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
