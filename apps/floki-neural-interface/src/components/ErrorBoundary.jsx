import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-full flex items-center justify-center p-8">
          <div className="max-w-md text-center space-y-3">
            <div className="w-12 h-12 mx-auto rounded-full bg-neon-red/10 border border-neon-red/30 flex items-center justify-center">
              <span className="text-neon-red text-lg font-bold">!</span>
            </div>
            <h2 className="text-sm font-semibold text-neon-red font-mono">UI Render Error</h2>
            <p className="text-xs text-muted-foreground font-mono">
              {this.state.error?.message || 'Unknown error'}
            </p>
            {this.props.fallback && (
              <div className="mt-4">{this.props.fallback}</div>
            )}
            <button
              onClick={() => this.setState({ error: null, info: null })}
              className="text-[10px] font-mono px-3 py-1 rounded border border-neon-cyan/30 text-neon-cyan hover:bg-neon-cyan/10 transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
