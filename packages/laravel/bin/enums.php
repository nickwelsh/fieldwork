<?php

declare(strict_types=1);

// Read only the declarative enum targets. Loading all config would resolve enum cases before generation.
$root = $argv[1] ?? throw new RuntimeException('An application root is required.');
$file = $root.'/config/formbraid.php';
if (! is_file($file)) {
    throw new RuntimeException('Publish config/formbraid.php before generating forms.');
}
$tokens = token_get_all(file_get_contents($file));
$imports = '';
$expression = null;
$depth = 0;
foreach ($tokens as $index => $token) {
    if (is_array($token) && $token[0] === T_USE && $depth === 0) {
        for ($cursor = $index; isset($tokens[$cursor]); $cursor++) {
            $part = $tokens[$cursor];
            $imports .= is_array($part) ? $part[1] : $part;
            if ($part === ';') {
                break;
            }
        }
    }
    if ($token === '[') {
        $depth++;
    } elseif ($token === ']') {
        $depth--;
    }
    if ($depth !== 1 || ! is_array($token) || $token[0] !== T_CONSTANT_ENCAPSED_STRING ||
        ! in_array($token[1], ["'enums'", '"enums"'], true)) {
        continue;
    }
    $expression = '';
    $nesting = 0;
    $started = false;
    for ($cursor = $index + 1; isset($tokens[$cursor]); $cursor++) {
        $part = $tokens[$cursor];
        if (! $started) {
            if (is_array($part) && $part[0] === T_DOUBLE_ARROW) {
                $started = true;
            }

            continue;
        }
        if (($part === ',' || $part === ']') && $nesting === 0) {
            break;
        }
        if (in_array($part, ['[', '('], true)) {
            $nesting++;
        } elseif (in_array($part, [']', ')'], true)) {
            $nesting--;
        }
        $expression .= is_array($part) ? $part[1] : $part;
    }
    break;
}
$targets = $expression === null ? [] : eval($imports.' return '.$expression.';');
if (! is_array($targets)) {
    throw new RuntimeException('formbraid.enums must be a declarative array of class names.');
}
$composer = json_decode(file_get_contents($root.'/composer.json'), true, flags: JSON_THROW_ON_ERROR);
$prefixes = array_merge($composer['autoload']['psr-4'] ?? [], $composer['autoload-dev']['psr-4'] ?? []);
uksort($prefixes, static fn (string $left, string $right): int => strlen($right) <=> strlen($left));
$output = [];
foreach ($targets as $registry => $class) {
    if ($class === null) {
        continue;
    }
    if (! in_array($registry, ['fields', 'components', 'groups'], true) || ! is_string($class) ||
        ! preg_match('/^[A-Za-z_]\w*(?:\\\\[A-Za-z_]\w*)+$/', $class)) {
        throw new RuntimeException('Invalid Formbraid enum target.');
    }
    $path = null;
    foreach ($prefixes as $prefix => $directory) {
        if (str_starts_with($class, $prefix)) {
            if (! is_string($directory)) {
                throw new RuntimeException('An enum namespace must map to one PSR-4 directory.');
            }
            $path = $directory.'/'.str_replace('\\', '/', substr($class, strlen($prefix))).'.php';
            break;
        }
    }
    if ($path === null) {
        throw new RuntimeException("No Composer PSR-4 mapping for enum {$class}.");
    }
    $parts = explode('\\', $class);
    $name = array_pop($parts);
    $output[] = ['registry' => $registry, 'path' => $path, 'namespace' => implode('\\', $parts), 'name' => $name];
}
echo json_encode($output, JSON_THROW_ON_ERROR);
