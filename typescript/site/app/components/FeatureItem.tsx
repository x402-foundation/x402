type FeatureItemProps = {
  title?: string;
  description: string;
  icon: React.ReactNode;
  iconBgColor?: string;
};

export function FeatureItem({
  title,
  description,
  icon,
  iconBgColor,
}: FeatureItemProps) {
  let iconClasses = 'rounded flex items-center justify-center flex-shrink-0';
  if (iconBgColor) {
    iconClasses += ` w-8 h-8 ${iconBgColor}`;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className={iconClasses}>{icon}</div>
        <div>
          {title && <h4 className="font-semibold text-gray-200">{title}</h4>}
          <p className="text-gray-400 max-w-sm">{description}</p>
        </div>
      </div>
    </div>
  );
}
