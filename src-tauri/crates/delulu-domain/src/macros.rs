/// A TypeScript string-literal union as a Rust enum: serde uses the exact
/// literals, and `as_str`, `parse` and `ALL` cover validation code. Legacy
/// literals after `|` still deserialize and parse, but never serialize.
#[macro_export]
macro_rules! string_enum {
    (
        $(#[$meta:meta])*
        $vis:vis enum $name:ident {
            $($(#[$vmeta:meta])* $variant:ident = $literal:literal $(| $legacy:literal)*),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
        $vis enum $name {
            $($(#[$vmeta])* #[serde(rename = $literal $(, alias = $legacy)*)] $variant),+
        }

        impl $name {
            /// Every value, in TypeScript declaration order.
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            /// The TypeScript literal.
            pub const fn as_str(self) -> &'static str {
                match self { $($name::$variant => $literal),+ }
            }

            /// The value for a TypeScript literal, if it is one.
            #[allow(clippy::should_implement_trait)]
            pub fn parse(value: &str) -> Option<Self> {
                match value { $($literal $(| $legacy)* => Some($name::$variant),)+ _ => None }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

/// Lazily compiled ports of JavaScript regex literals: `NAME = source, flags;`.
macro_rules! regexes {
    ($($name:ident = $source:expr, $flags:expr;)+) => {
        $(static $name: std::sync::LazyLock<regex::Regex> =
            std::sync::LazyLock::new(|| $crate::js::regex($source, $flags));)+
    };
}
