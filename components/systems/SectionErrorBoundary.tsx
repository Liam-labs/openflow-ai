'use client';

import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: React.ReactNode;
  sectionName?: string;
}

interface State {
  error: Error | null;
}

export class SectionErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[SystemsTab] Section error in "${this.props.sectionName ?? 'unknown'}":`, error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="section-error-boundary">
          <AlertTriangle size={20} className="section-error-boundary__icon" />
          <p className="section-error-boundary__title">
            {this.props.sectionName ? `${this.props.sectionName} failed to load` : 'Section failed to load'}
          </p>
          <p className="section-error-boundary__detail">{this.state.error.message}</p>
          <button
            className="systems-section__btn"
            onClick={() => this.setState({ error: null })}
          >
            <RefreshCw size={13} />
            <span>Retry</span>
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
