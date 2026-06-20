import React, { useState } from 'react';
import { cn } from '@/lib/utils';
import { Copy, Check, RefreshCw, Mic, Bot } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function ChatMessage({ message, showTimestamps = true }) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';
  const isStreaming = message.isStreaming;

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={cn('flex gap-3 px-4 py-3 group', isUser ? 'flex-row-reverse' : 'flex-row')}>
      {/* Avatar */}
      <div className={cn(
        'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5',
        isUser
          ? 'bg-neon-blue/15 border border-neon-blue/30'
          : 'bg-neon-cyan/10 border border-neon-cyan/30'
      )}>
        {isUser ? (
          <span className="text-xs font-bold text-neon-blue">U</span>
        ) : (
          <Bot className="w-4 h-4 text-neon-cyan" />
        )}
      </div>

      {/* Content */}
      <div className={cn('flex flex-col max-w-[80%] min-w-0', isUser ? 'items-end' : 'items-start')}>
        {/* Meta row */}
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[11px] font-semibold text-muted-foreground">
            {isUser ? 'You' : 'Floki'}
          </span>
          {message.type === 'spoken' && (
            <Mic className="w-3 h-3 text-neon-green/70" />
          )}
          {message.type === 'typed' && !isUser && null}
          {showTimestamps && (
            <span className="text-[10px] font-mono text-muted-foreground/60">
              {formatTime(message.timestamp)}
            </span>
          )}
        </div>

        {/* Bubble */}
        <div className={cn(
          'rounded-xl px-4 py-2.5 text-sm leading-relaxed',
          isUser
            ? 'bg-neon-blue/10 border border-neon-blue/20 text-foreground'
            : 'bg-secondary/50 border border-border/50 text-foreground'
        )}>
          {isUser ? (
            <p className="whitespace-pre-wrap">{message.content}</p>
          ) : (
            <ReactMarkdown
              className="prose prose-sm prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
              components={{
                code: ({ inline, className, children, ...props }) => {
                  if (!inline) {
                    return (
                      <pre className="bg-background/80 rounded-md p-3 overflow-x-auto my-2 border border-border/50">
                        <code className={cn("text-xs font-mono text-neon-cyan/90", className)} {...props}>{children}</code>
                      </pre>
                    );
                  }
                  return <code className="px-1 py-0.5 rounded bg-background/60 text-neon-cyan/80 text-xs font-mono">{children}</code>;
                },
                p: ({ children }) => <p className="my-1 leading-relaxed">{children}</p>,
              }}
            >
              {message.content}
            </ReactMarkdown>
          )}
          {isStreaming && (
            <span className="inline-block w-2 h-4 bg-neon-cyan/80 ml-0.5 animate-pulse rounded-sm" />
          )}
        </div>

        {/* Action buttons for Floki messages */}
        {!isUser && !isStreaming && message.content && (
          <TooltipProvider delayDuration={300}>
            <div className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={handleCopy} className="p-1 rounded hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors">
                    {copied ? <Check className="w-3.5 h-3.5 text-neon-green" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">{copied ? 'Copied' : 'Copy'}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="p-1 rounded hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors">
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">Regenerate</TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        )}
      </div>
    </div>
  );
}