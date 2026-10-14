import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { EmptyState } from '@/components/ui/primitives';

export default function NotFoundPage() {
  return (
    <EmptyState
      icon={<Compass className="h-8 w-8" />}
      title="This page doesn't exist"
      description="The link may be out of date. Use search (Ctrl K) or go back to the dashboard."
      action={<Link to="/" className="text-sm font-medium text-signal hover:underline">Go to dashboard</Link>}
    />
  );
}
