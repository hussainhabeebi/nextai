import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { REPORT_NAMES } from '@nextai/shared';
import { Page } from '@/components/page';
import { Card } from '@/components/ui/card';

export default function Reports() {
  return (
    <Page title="Reports" back="/more">
      <Card className="divide-y divide-line p-0">
        {Object.entries(REPORT_NAMES).map(([key, name]) => (
          <Link key={key} href={`/reports/${key}`} className="flex min-h-14 items-center px-4">
            <span className="flex-1">{name}</span>
            <ChevronRight className="h-4 w-4 text-muted rtl:rotate-180" />
          </Link>
        ))}
      </Card>
      <p className="mt-4 text-xs text-muted">Registers (sales/purchase) and GST/VAT returns are in the Tax centre.</p>
    </Page>
  );
}
