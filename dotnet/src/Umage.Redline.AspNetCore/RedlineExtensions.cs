using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Umage.Redline.Hosting;

namespace Umage.Redline;

public static class RedlineExtensions
{
    const string Added = "Umage.Redline.MiddlewareAdded";

    /// <summary>
    /// Add Redline. By default it runs in Development only and puts its middleware first in the
    /// pipeline (so it sees every HTML response); call <see cref="UseRedline"/> to place it yourself.
    /// </summary>
    public static IServiceCollection AddRedline(this IServiceCollection services, Action<RedlineOptions>? configure = null)
    {
        services.AddOptions<RedlineOptions>();
        if (configure is not null) services.Configure(configure);
        services.TryAddSingleton<RedlineRuntime>();
        services.TryAddEnumerable(ServiceDescriptor.Transient<IStartupFilter, RedlineStartupFilter>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IHostedService, RedlineRegistration>());
        return services;
    }

    /// <summary>The Redline middleware here (instead of first). A no-op when Redline is off or already added.</summary>
    public static IApplicationBuilder UseRedline(this IApplicationBuilder app)
    {
        if (app.Properties.ContainsKey(Added)) return app;
        var rt = app.ApplicationServices.GetService<RedlineRuntime>()
            ?? throw new InvalidOperationException("Call services.AddRedline() before app.UseRedline().");
        app.Properties[Added] = true;
        if (rt.Enabled) app.UseMiddleware<RedlineMiddleware>();
        return app;
    }

    sealed class RedlineStartupFilter : IStartupFilter
    {
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            // First in the pipeline, unless the app places it with app.UseRedline() (ManualPlacement).
            var rt = app.ApplicationServices.GetRequiredService<RedlineRuntime>();
            if (!rt.Options.ManualPlacement) app.UseRedline();
            next(app);
        };
    }

    /// <summary>Registers the dev server in .redline/servers.json once it listens, so `redline mcp` finds it (D22).</summary>
    sealed class RedlineRegistration : IHostedService
    {
        readonly RedlineRuntime _rt;
        readonly IServer _server;
        readonly IHostApplicationLifetime _life;

        public RedlineRegistration(RedlineRuntime rt, IServer server, IHostApplicationLifetime life)
        {
            _rt = rt;
            _server = server;
            _life = life;
        }

        public Task StartAsync(CancellationToken ct)
        {
            if (!_rt.Enabled || _rt.Options.Online) return Task.CompletedTask;
            _life.ApplicationStarted.Register(() =>
            {
                var addresses = _server.Features.Get<IServerAddressesFeature>()?.Addresses ?? Array.Empty<string>();
                foreach (var a in addresses) _rt.Register(a.Replace("://[::]", "://localhost").Replace("://0.0.0.0", "://localhost").Replace("://+", "://localhost").Replace("://*", "://localhost"));
            });
            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
    }
}
