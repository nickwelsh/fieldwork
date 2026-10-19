<?php

declare(strict_types=1);

namespace Formbraid\Laravel\Tests;

use Formbraid\Laravel\FormbraidServiceProvider;
use Formbraid\Laravel\Tests\Fixtures\ProfileRequest;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Route;
use Orchestra\Testbench\TestCase;

final class ExportCommandTest extends TestCase
{
    protected function getPackageProviders($app): array
    {
        return [FormbraidServiceProvider::class];
    }

    public function test_export_discovers_form_requests_and_routes_without_authorization(): void
    {
        Route::patch('/users/{user}', static function (ProfileRequest $request): void {})->name('users.update');
        config(['formbraid.requests' => ['../../../../tests/Fixtures']]);
        $exit = Artisan::call('formbraid:export');
        self::assertSame(0, $exit);
        $export = json_decode(Artisan::output(), true, flags: JSON_THROW_ON_ERROR);
        self::assertSame(1, $export['version']);
        self::assertCount(1, $export['forms']);
        self::assertSame(ProfileRequest::class, $export['forms'][0]['id']);
        self::assertSame('TextField', $export['forms'][0]['fields']['name']['component']);
        self::assertArrayNotHasKey('actions', $export);
        self::assertArrayNotHasKey('target', $export['forms'][0]);
        self::assertSame(0, Artisan::call('formbraid:http'));
        $http = json_decode(Artisan::output(), true, flags: JSON_THROW_ON_ERROR);
        self::assertSame([
            'name' => 'users.update', 'schema' => ProfileRequest::class,
            'parameters' => [['name' => 'user', 'optional' => false]],
            'binding' => ['uri' => 'users/{user}', 'method' => 'patch'],
        ], $http['operations'][0]);
    }
}
