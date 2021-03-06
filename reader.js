/*  EdgeLisp: A Lisp that compiles to JavaScript.
    Copyright (C) 2008-2011 by Manuel Simoni.

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as
    published by the Free Software Foundation, version 3.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>. */

/*** Syntax ***/

/* EdgeLisp does not use a cons-based representation for Lisp source.
   Instead, forms are represented as objects, which makes it possible
   to attach additional information to forms, e.g. file name and line
   number.  EdgeLisp also has a separation between in-language
   datatypes (e.g. strings) and their syntactic representations
   (e.g. string forms).  A string form in the Lisp source is not a
   Lisp string: a string in the source (a string form) may have a line
   number or other metadata attached to it, whereas an in-language
   string is simply a string.

   There are multiple types of forms; number forms, string forms,
   identifier forms, and compound forms:
   
   1.2   --> { formt: "number", sign: "+", integral_digits: "1",
               fractional_digits: ".2" }
   "foo" --> { formt: "string", s: "foo" }
   foo   --> { formt: "identifier", name: "foo" }
   (foo) --> { formt: "compound", 
               elts: [ { formt: "identifier", name: "foo" } ] } 
   ; line comments are ignored
*/

var lisp_expression_syntax =
    function(input) { return lisp_expression_syntax(input); }; // forward decl.

/**** Comments ****/

var lisp_line_terminator = choice(ch("\r"), ch("\n"));

var lisp_line_comment_syntax =
    action(join_action(sequence(";",
                                repeat0(negate(lisp_line_terminator)),
                                optional(lisp_line_terminator)),
                       ""),
           lisp_line_comment_action);

function lisp_line_comment_action(ast)
{
    return new Lisp_comment_form(ast);
}

/**** Numbers ****/

var lisp_digits = 
    join_action(repeat1(range("0", "9")), "");

var lisp_number_syntax =
    action(sequence(optional(choice("+", "-")),
                    lisp_digits,
                    optional(join_action(sequence(".", lisp_digits), ""))),
           lisp_number_syntax_action);

function lisp_number_syntax_action(ast)
{    
    var sign = ast[0] ? ast[0] : "+";
    var integral_digits = ast[1];
    var fractional_digits = ast[2] || "";
    return new Lisp_number_form(sign, integral_digits, fractional_digits);
}

/**** Strings ****/

var lisp_escape_char =
    choice("\"", "\\");

var lisp_escape_sequence =
    action(sequence("\\", lisp_escape_char),
           lisp_escape_sequence_action);

var lisp_string_char =
    choice(negate(lisp_escape_char), 
           lisp_escape_sequence);

var lisp_string_syntax =
    action(sequence("\"", join_action(repeat0(lisp_string_char), ""), "\""),
           lisp_string_syntax_action);

function lisp_escape_sequence_action(ast)
{
    var escape_char = ast[1];
    return escape_char;
}

function lisp_string_syntax_action(ast)
{
    return new Lisp_string_form(ast[1]);
}

/**** Identifiers ****/

var lisp_identifier_special_char =
    // Needs to be in sync with `lisp_mangle_table'.
    choice("-", "&", "!", ":", ".", "=", ">","<", "%", "+", "?", "/", "*", "#");

var lisp_identifier_syntax =
    action(join_action(repeat1(choice(range("a", "z"),
                                      range("0", "9"),
                                      lisp_identifier_special_char)),
                       ""),
           lisp_identifier_syntax_action);

function lisp_identifier_syntax_action(ast)
{
    return new Lisp_identifier_form(ast);
}

/**** Compounds ****/

var lisp_compound_syntax =
    action(wsequence("(", repeat0(lisp_expression_syntax), ")"),
           lisp_compound_syntax_action);

function lisp_compound_syntax_action(ast)
{
    var forms = ast[1];
    return new Lisp_compound_form(lisp_remove_comment_forms(forms));
}

/**** Inline JavaScript ****/

var lisp_native_escape =
    action(sequence("~", lisp_expression_syntax),
           lisp_native_escape_action);

var lisp_native_syntax =
    action(sequence("#{",
                    repeat1(choice(lisp_native_escape,
                                   action(choice(negate("#"),
                                                 join_action(sequence("#",
                                                                      not("}")),
                                                             "")),
                                          lisp_native_snippet_action))),
                    "#}"),
           lisp_native_action);

function lisp_native_escape_action(ast)
{
    return ast[1];
}

function lisp_native_snippet_action(ast)
{
    return new Lisp_compound_form([ new Lisp_identifier_form("%%native-snippet"),
                                    new Lisp_string_form(ast) ]);
}

function lisp_native_action(ast)
{
    return new Lisp_compound_form([ new Lisp_identifier_form("%%native") ]
                                  .concat(ast[1]));
}

/**** Misc shortcuts ****/

var lisp_quote_syntax =
    action(sequence("#'", lisp_expression_syntax),
           lisp_shortcut_syntax_action("%%quasiquote"));

var lisp_quasiquote_syntax =
    action(sequence("#`", lisp_expression_syntax),
           lisp_shortcut_syntax_action("%%quasiquote"));

var lisp_unquote_syntax =
    action(sequence(",", lisp_expression_syntax),
           lisp_shortcut_syntax_action("%%unquote"));

var lisp_unquote_splicing_syntax =
    action(sequence(",@", lisp_expression_syntax),
           lisp_shortcut_syntax_action("%%unquote-splicing"));

var lisp_function_syntax =
    action(sequence("\\", lisp_identifier_syntax),
           lisp_shortcut_syntax_action("function"));

function lisp_shortcut_syntax_action(name)
{
    return function(ast) {
        return new Lisp_compound_form([ new Lisp_identifier_form(name),
                                        ast[1] ]);
    }
}

/**** Programs ****/

var lisp_expression_syntax =
    whitespace(choice(lisp_line_comment_syntax,
                      lisp_number_syntax,
                      lisp_string_syntax,
                      lisp_compound_syntax,
                      lisp_native_syntax,
                      lisp_quote_syntax,
                      lisp_quasiquote_syntax,
                      lisp_unquote_syntax,
                      lisp_unquote_splicing_syntax,
                      lisp_function_syntax,
                      lisp_identifier_syntax));

var lisp_program_syntax =
    whitespace(repeat1(lisp_expression_syntax));

function lisp_read(string)
{
    var result = lisp_program_syntax(ps(string));
    if (result.ast) {
        return lisp_remove_comment_forms(result.ast);
    } else {
        return lisp_error("Reader error", string);
    }
}

function lisp_remove_comment_forms(forms)
{
    var res = [];
    for (var i = 0, len = forms.length; i < len; i++) {
        var form = forms[i];
        if (form.formt !== "comment")
            res.push(form);
    }
    return res;

}

// Reads a single form from string.
function lisp_read_from_string(string)
{
    var result = lisp_expression_syntax(ps(string));
    if (result.ast) {
        return result.ast;
    } else {
        return lisp_error("Reader error", string);
    }
}
