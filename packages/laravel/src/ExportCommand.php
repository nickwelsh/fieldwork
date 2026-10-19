<?php

declare(strict_types=1);

namespace Formbraid\Laravel;

use Illuminate\Console\Command;
use Illuminate\Foundation\Http\FormRequest;
use ReflectionClass;
use Symfony\Component\Finder\Finder;

final class ExportCommand extends Command
{
    protected $signature = 'formbraid:export {--profile= : Backend discovery profile}';

    protected $description = 'Export Laravel form definitions as the portable Formbraid JSON contract';

    public function handle(): int
    {
        $config = config('formbraid');
        if (! is_array($config)) {
            throw new \RuntimeException('Missing Formbraid configuration.');
        }
        $profile = $this->option('profile');
        if (is_string($profile) && $profile !== '') {
            $profiles = $config['profiles'] ?? [];
            if (! is_array($profiles) || ! isset($profiles[$profile]) || ! is_array($profiles[$profile])) {
                throw new \RuntimeException("Unknown Formbraid profile: {$profile}");
            }
            $config = array_replace($config, $profiles[$profile]);
        }
        $configuration = Configuration::from($config);
        $extractor = new RequestExtractor($configuration);
        $directories = $configuration->requests;
        $classes = [];
        foreach ($directories as $directory) {
            $path = base_path($directory);
            if (! is_dir($path)) {
                throw new \RuntimeException("Request directory does not exist: {$path}");
            }
            foreach ((new Finder)->files()->in($path)->name('*.php')->sortByName() as $file) {
                foreach ($this->classesIn($file->getContents()) as $class) {
                    if (is_subclass_of($class, FormRequest::class) && ! (new ReflectionClass($class))->isAbstract()) {
                        $classes[$class] = null;
                    }
                }
            }
        }
        ksort($classes);
        $forms = [];
        $diagnostics = [];
        foreach (array_keys($classes) as $class) {
            // Avoid container resolution: it would trigger FormRequest validation/authorization.
            $request = $class::createFrom(request(), new $class);
            $request->setContainer(app());
            try {
                $extracted = $extractor->extract($request);
            } catch (\Throwable $error) {
                throw new \RuntimeException("Cannot export {$class}: {$error->getMessage()}. Generation needs rules that can be described without live request data.", previous: $error);
            }
            $forms[] = $extracted['form'];
            $diagnostics = array_merge($diagnostics, $extracted['diagnostics']);
        }
        $this->line(json_encode(['version' => 1, 'forms' => $forms, 'diagnostics' => $diagnostics], JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

        return self::SUCCESS;
    }

    /** @return list<class-string> */
    private function classesIn(string $source): array
    {
        $tokens = token_get_all($source);
        $namespace = '';
        $classes = [];
        foreach ($tokens as $index => $token) {
            if (! is_array($token)) {
                continue;
            }
            if ($token[0] === T_NAMESPACE) {
                $namespace = '';
                for ($cursor = $index + 1; isset($tokens[$cursor]); $cursor++) {
                    $part = $tokens[$cursor];
                    if ($part === ';' || $part === '{') {
                        break;
                    }
                    if (is_array($part) && in_array($part[0], [T_STRING, T_NAME_QUALIFIED, T_NS_SEPARATOR], true)) {
                        $namespace .= $part[1];
                    }
                }
            }
            if ($token[0] === T_CLASS) {
                for ($cursor = $index + 1; isset($tokens[$cursor]); $cursor++) {
                    $part = $tokens[$cursor];
                    if (is_array($part) && $part[0] === T_WHITESPACE) {
                        continue;
                    }
                    if (is_array($part) && $part[0] === T_STRING) {
                        $name = ($namespace === '' ? '' : $namespace.'\\').$part[1];
                        if (class_exists($name)) {
                            $classes[] = $name;
                        }
                    }
                    break;
                }
            }
        }

        return $classes;
    }
}
