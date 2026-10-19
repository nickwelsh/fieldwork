<?php

declare(strict_types=1);

namespace Formbraid\Laravel;

use Illuminate\Support\ServiceProvider;

final class FormbraidServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__.'/../config/formbraid.php', 'formbraid');
    }

    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->commands([ExportCommand::class, HttpOperationsCommand::class]);
            $this->publishes([__DIR__.'/../config/formbraid.php' => config_path('formbraid.php')], 'formbraid-config');
        }
    }
}
